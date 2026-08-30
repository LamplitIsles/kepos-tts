import { credentialRef, type CredentialProvider, type ResolvedCredential } from "@deepseek-ai/dsh-credentials";
import type { HostConnectionRpc, ConnectionRpcHandler } from "@deepseek-ai/dsh-client-connection";
import type { RpcResult } from "@deepseek-ai/dsh-host-apiproxy/api";

import {
  ALIBABA_MODEL,
  BYTEDANCE_ENDPOINT,
  BYTEDANCE_RESOURCE_ID,
  DASHSCOPE_ENDPOINT,
  TTS_MAX_CHARS,
  normalizeProfile,
  profileFromSettings,
  type TtsProfile
} from "./constants.js";
import { normalizeTtsText } from "./parser.js";
import {
  AUDIO_ROUTE_PATH,
  CACHE_FORMAT_VERSION,
  MAX_AUDIO_BYTES,
  TTS_CACHE_DIRECTORY,
  audioArtifactPath,
  audioCacheDirectory,
  audioUrl,
  cacheDigest,
  readAudioArtifact,
  readAudioArtifactMetadata,
  registerTtsAudioRoute,
  resolveSessionWorkspace,
  serveTtsAudio,
  writeAudioArtifactAtomic,
  type AudioRouteRegistrar,
  type AudioResponse,
  type SessionResolver
} from "./audio-cache.js";
import { RPC_CHANNEL, RPC_ENDPOINT, type BrowserAudioPayload } from "./rpc.js";

export type TtsFailureCategory =
  | "invalid-input"
  | "unavailable"
  | "provider-rejected"
  | "provider-invalid-audio"
  | "internal"
  | "cancelled";

export { RPC_CHANNEL, RPC_ENDPOINT } from "./rpc.js";
export type { BrowserAudioPayload } from "./rpc.js";
export {
  AUDIO_ROUTE_PATH,
  CACHE_FORMAT_VERSION,
  MAX_AUDIO_BYTES,
  TTS_CACHE_DIRECTORY,
  audioArtifactPath,
  audioCacheDirectory,
  audioUrl,
  cacheDigest,
  readAudioArtifact,
  readAudioArtifactMetadata,
  registerTtsAudioRoute,
  resolveSessionWorkspace,
  serveTtsAudio,
  writeAudioArtifactAtomic
} from "./audio-cache.js";
export type { AudioRouteRegistrar, AudioResponse, SessionResolver } from "./audio-cache.js";

export interface CredentialResolver {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<ResolvedCredential | undefined>;
}

export interface TtsGatewayOptions {
  credentials: CredentialResolver | Pick<CredentialProvider, "resolve">;
  sessions: SessionResolver;
  /** Normalized settings are resolved for each admitted cache miss. */
  getSettings?: () => unknown;
  /** A host may provide the already normalized profile directly. */
  getProfile?: () => unknown;
  fetch?: typeof fetch;
}

export class TtsGatewayError extends Error {
  readonly category: TtsFailureCategory;

  constructor(category: TtsFailureCategory) {
    super(category);
    this.name = "TtsGatewayError";
    this.category = category;
  }
}

function failure<T>(category: TtsFailureCategory): RpcResult<T> {
  const code = category === "invalid-input" ? "bad-request" : category === "cancelled" ? "cancelled" : "internal";
  if (code === "bad-request") {
    return {
      ok: false,
      error: { code, message: category, details: { issues: [] } }
    } as RpcResult<T>;
  }
  if (code === "cancelled") {
    return { ok: false, error: { code, message: category, details: {} } } as RpcResult<T>;
  }
  return { ok: false, error: { code: "internal", message: category, details: {} } } as RpcResult<T>;
}

/** Leave enough room for JSON framing while bounding any provider response. */
const MAX_PROVIDER_JSON_BYTES = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 64 * 1024;

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      throw new Error("response-too-large");
    }
  }
  if (!response.body) throw new Error("empty-response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Strict base64 decoding; Buffer.from alone silently accepts malformed input. */
function base64ToBytes(value: string): Uint8Array | undefined {
  const dataUri = value.match(/^data:[^;,]+;base64,(.*)$/s);
  if (dataUri) value = dataUri[1]!;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  if (value.includes("=") && value.length % 4 !== 0) return undefined;
  const encoded = value + padding;
  try {
    const buffer = (globalThis as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;
    if (buffer) {
      return new Uint8Array(buffer.from(encoded, "base64"));
    }
    const decoded = atob(encoded);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

interface SynthesisRequest {
  text: string;
  sessionId: string;
}

function requestFromPayload(payload: unknown): SynthesisRequest {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TtsGatewayError("invalid-input");
  }
  const record = payload as { text?: unknown; sessionId?: unknown };
  const keys = Object.keys(payload);
  if (keys.some((key) => key !== "text" && key !== "sessionId") || !keys.includes("text") || !keys.includes("sessionId")) {
    throw new TtsGatewayError("invalid-input");
  }
  if (typeof record.text !== "string" || typeof record.sessionId !== "string" || !record.sessionId.trim()) {
    throw new TtsGatewayError("invalid-input");
  }
  const text = normalizeTtsText(record.text);
  if (!text || Array.from(text).length > TTS_MAX_CHARS) throw new TtsGatewayError("invalid-input");
  return { text, sessionId: record.sessionId };
}

function providerAudio(response: unknown): { data?: string; url?: string } | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const output = (response as { output?: unknown }).output;
  if (typeof output !== "object" || output === null) return undefined;
  const audio = (output as { audio?: unknown }).audio;
  if (typeof audio !== "object" || audio === null) return undefined;
  const data = (audio as { data?: unknown }).data;
  const url = (audio as { url?: unknown }).url;
  return {
    ...(typeof data === "string" ? { data } : {}),
    ...(typeof url === "string" ? { url } : {})
  };
}

async function alibabaBytes(
  fetchImpl: typeof fetch,
  credential: ResolvedCredential,
  text: string,
  voice: string
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(DASHSCOPE_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.value}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: ALIBABA_MODEL,
        input: { text, voice, language_type: "Chinese" },
        parameters: { format: "mp3" },
        stream: false
      })
    });
  } catch {
    throw new TtsGatewayError("provider-rejected");
  }
  if (!response.ok) throw new TtsGatewayError("provider-rejected");

  let body: unknown;
  try {
    const encoded = await readBoundedResponse(response, MAX_PROVIDER_JSON_BYTES);
    body = JSON.parse(new TextDecoder().decode(encoded));
  } catch {
    throw new TtsGatewayError("provider-invalid-audio");
  }
  const audio = providerAudio(body);
  if (!audio) throw new TtsGatewayError("provider-invalid-audio");
  let bytes: Uint8Array | undefined;
  if (audio.data) bytes = base64ToBytes(audio.data);
  if ((!bytes || bytes.length === 0) && audio.url) {
    try {
      const url = new URL(audio.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
      const audioResponse = await fetchImpl(url.toString(), { method: "GET" });
      if (!audioResponse.ok) throw new Error("status");
      const contentType = typeof audioResponse.headers?.get === "function" ? audioResponse.headers.get("content-type") : "";
      if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") throw new Error("content-type");
      bytes = await readBoundedResponse(audioResponse, MAX_AUDIO_BYTES);
    } catch {
      throw new TtsGatewayError("provider-invalid-audio");
    }
  }
  if (!bytes || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
    throw new TtsGatewayError("provider-invalid-audio");
  }
  return bytes;
}

interface ByteDanceFrame {
  code?: number;
  data?: string;
  message?: string;
}

function asFrame(value: unknown): ByteDanceFrame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const header = typeof record.header === "object" && record.header !== null && !Array.isArray(record.header)
    ? record.header as Record<string, unknown>
    : undefined;
  if ("code" in record && typeof record.code !== "number") return undefined;
  if ("data" in record && typeof record.data !== "string") return undefined;
  if ("message" in record && typeof record.message !== "string") return undefined;
  if (header && "code" in header && typeof header.code !== "number") return undefined;
  if (header && "message" in header && typeof header.message !== "string") return undefined;
  const code = typeof record.code === "number" ? record.code : typeof header?.code === "number" ? header.code : undefined;
  const data = typeof record.data === "string" ? record.data : undefined;
  const message = typeof record.message === "string" ? record.message : typeof header?.message === "string" ? header.message : undefined;
  if (code === undefined && data === undefined && message === undefined) return undefined;
  return { ...(code === undefined ? {} : { code }), ...(data === undefined ? {} : { data }), ...(message === undefined ? {} : { message }) };
}

/** Parse one JSON response or newline/SSE `data:` JSON frames. */
export function parseByteDanceFrames(text: string): ByteDanceFrame[] | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const frame = asFrame(JSON.parse(trimmed));
    return frame ? [frame] : undefined;
  } catch {
    // The unidirectional endpoint may return one frame per line.
  }
  const frames: ByteDanceFrame[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const item = line.trim();
    if (!item) continue;
    if (item.startsWith(":") || item.startsWith("event:") || item.startsWith("id:") || item.startsWith("retry:")) continue;
    const json = item.startsWith("data:") ? item.slice("data:".length).trim() : item;
    if (!json || json === "[DONE]") continue;
    try {
      const frame = asFrame(JSON.parse(json));
      if (!frame) return undefined;
      frames.push(frame);
    } catch {
      return undefined;
    }
  }
  return frames.length > 0 ? frames : undefined;
}

async function bytedanceBytes(
  fetchImpl: typeof fetch,
  credential: ResolvedCredential,
  text: string,
  voice: string
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(BYTEDANCE_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Api-Key": credential.value,
        "X-Api-Resource-Id": BYTEDANCE_RESOURCE_ID
      },
      body: JSON.stringify({
        user: { uid: "kepos-tts" },
        req_params: {
          text,
          speaker: voice,
          audio_params: { format: "mp3", sample_rate: 24_000 }
        }
      })
    });
  } catch {
    throw new TtsGatewayError("provider-rejected");
  }
  if (!response.ok) throw new TtsGatewayError("provider-rejected");

  let frames: ByteDanceFrame[] | undefined;
  try {
    const encoded = await readBoundedResponse(response, MAX_PROVIDER_JSON_BYTES);
    frames = parseByteDanceFrames(new TextDecoder().decode(encoded));
  } catch {
    frames = undefined;
  }
  if (!frames) throw new TtsGatewayError("provider-invalid-audio");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const frame of frames) {
    if (frame.code === 0) {
      if (frame.data !== undefined) {
        const bytes = base64ToBytes(frame.data);
        if (!bytes || total + bytes.length > MAX_AUDIO_BYTES) {
          throw new TtsGatewayError("provider-invalid-audio");
        }
        if (bytes.length > 0) {
          chunks.push(bytes);
          total += bytes.length;
        }
      }
      continue;
    }
    if (frame.code === 20_000_000) continue;
    throw new TtsGatewayError("provider-rejected");
  }
  if (total === 0) throw new TtsGatewayError("provider-invalid-audio");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function providerBytes(
  fetchImpl: typeof fetch,
  credential: ResolvedCredential,
  text: string,
  profile: TtsProfile
): Promise<Uint8Array> {
  return profile.provider === "bytedance"
    ? bytedanceBytes(fetchImpl, credential, text, profile.voice)
    : alibabaBytes(fetchImpl, credential, text, profile.voice);
}

/** Shared in-flight work survives individual gateway instances and renderer disposal. */
const inFlight = new Map<string, Promise<number>>();

export class TtsGateway {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TtsGatewayOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private profile(): TtsProfile {
    if (this.options.getProfile) return normalizeProfile(this.options.getProfile());
    return profileFromSettings(this.options.getSettings?.());
  }

  private async generateAndCache(path: string, text: string, profile: TtsProfile): Promise<number> {
    // This disk check wins a race with another process that published the same
    // deterministic artifact while this request was being scheduled.
    const existing = await readAudioArtifactMetadata(path, MAX_AUDIO_BYTES);
    if (existing) return existing.size;
    const credential = await this.options.credentials.resolve(credentialRef(profile.credentialRef));
    if (!credential?.value) throw new TtsGatewayError("unavailable");
    const bytes = await providerBytes(this.fetchImpl, credential, text, profile);
    await writeAudioArtifactAtomic(path, bytes, MAX_AUDIO_BYTES);
    return bytes.byteLength;
  }

  private async artifact(path: string, text: string, profile: TtsProfile): Promise<number> {
    const pending = inFlight.get(path);
    if (pending) return pending;
    // Keep the in-flight entry from the initial disk lookup onward. This
    // closes the small race where identical callers both observe a miss before
    // either provider request has started.
    const generation = this.generateAndCache(path, text, profile);
    inFlight.set(path, generation);
    generation.then(
      () => {
        if (inFlight.get(path) === generation) inFlight.delete(path);
      },
      () => {
        if (inFlight.get(path) === generation) inFlight.delete(path);
      }
    );
    return generation;
  }

  async synthesize(payload: unknown, signal?: AbortSignal): Promise<BrowserAudioPayload> {
    if (signal?.aborted) throw new TtsGatewayError("cancelled");
    const request = requestFromPayload(payload);
    const profile = this.profile();
    const workspace = resolveSessionWorkspace(this.options.sessions, request.sessionId);
    if (!workspace) throw new TtsGatewayError("unavailable");
    const digest = cacheDigest(request.text, profile, CACHE_FORMAT_VERSION);
    const path = audioArtifactPath(workspace, digest);
    // The provider request intentionally does not receive the browser signal:
    // once admitted, generation must finish so another occurrence can reuse it.
    const bytes = await this.artifact(path, request.text, profile);
    return {
      mediaType: "audio/mpeg",
      url: audioUrl(request.sessionId, digest),
      bytes
    };
  }

  async handle(endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult<BrowserAudioPayload>> {
    if (endpoint !== RPC_ENDPOINT) return failure("invalid-input");
    try {
      return { ok: true, value: await this.synthesize(payload, signal) };
    } catch (error) {
      const category = error instanceof TtsGatewayError ? error.category : "internal";
      return failure(category);
    }
  }
}

export function createTtsRpcHandler(gateway: TtsGateway): ConnectionRpcHandler {
  return (endpoint, payload, signal) => gateway.handle(endpoint, payload, signal);
}

export function registerTtsRpc(
  connection: Pick<HostConnectionRpc, "handle">,
  gateway: TtsGateway
): () => Promise<void> {
  return connection.handle(RPC_CHANNEL, createTtsRpcHandler(gateway), { authority: "trusted-host" });
}
