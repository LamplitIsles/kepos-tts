import { credentialRef, type CredentialProvider, type ResolvedCredential } from "@deepseek-ai/dsh-credentials";
import type { HostConnectionRpc, ConnectionRpcHandler, ConnectionRpcResult } from "@deepseek-ai/dsh-client-connection";

import {
  ALIBABA_MODEL,
  BYTEDANCE_ENDPOINT,
  BYTEDANCE_RESOURCE_ID,
  DASHSCOPE_ENDPOINT,
  TTS_MAX_CHARS,
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

export interface TtsFailureDiagnostic {
  category: TtsFailureCategory;
  provider?: TtsProfile["provider"];
  voice?: string;
  stage?: "session" | "credential" | "network" | "http" | "provider-response";
  httpStatus?: number;
  responseContentType?: string;
  responseBytes?: number;
  requestId?: string;
  responseIssue?: "read-failed" | "invalid-json" | "invalid-frame" | "no-data-frames";
}

/** Stable input accepted by the optional Host-facing `keposTts` service. */
export interface KeposTtsSynthesisRequest {
  sessionId: string;
  text: string;
}

/** Bounded MP3 payload returned by the optional Host-facing `keposTts` service. */
export interface KeposTtsAudio {
  mediaType: "audio/mpeg";
  data: Uint8Array;
}

/** Optional in-process Host capability offered while the Kepos plugin is mounted. */
export interface KeposTtsService {
  synthesize(request: KeposTtsSynthesisRequest, signal?: AbortSignal): Promise<KeposTtsAudio>;
}

/** Cordis key for the optional Host TTS capability. */
export const KEPOS_TTS_SERVICE = "keposTts" as const;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Optional Host TTS capability supplied by Kepos TTS when mounted. */
    keposTts: KeposTtsService;
  }
}

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
  getSettings: () => unknown;
  fetch?: typeof fetch;
  onFailure?: (failure: TtsFailureDiagnostic) => void;
}

export class TtsGatewayError extends Error {
  readonly category: TtsFailureCategory;
  readonly diagnostic: Omit<TtsFailureDiagnostic, "category">;

  constructor(category: TtsFailureCategory, diagnostic: Omit<TtsFailureDiagnostic, "category"> = {}) {
    super(category);
    this.name = "TtsGatewayError";
    this.category = category;
    this.diagnostic = diagnostic;
  }
}

function providerDiagnostic(
  profile: Pick<TtsProfile, "provider" | "voice">,
  stage: NonNullable<TtsFailureDiagnostic["stage"]>,
  detail: Pick<TtsFailureDiagnostic, "httpStatus" | "responseContentType" | "responseBytes" | "requestId" | "responseIssue"> = {}
): Omit<TtsFailureDiagnostic, "category"> {
  return { provider: profile.provider, voice: profile.voice, stage, ...detail };
}

function failure<T>(category: TtsFailureCategory): ConnectionRpcResult<T> {
  const code = category === "invalid-input" ? "bad-request" : category === "cancelled" ? "cancelled" : "internal";
  if (code === "bad-request") {
    return {
      ok: false,
      error: { code, message: category, details: { issues: [] } }
    } as ConnectionRpcResult<T>;
  }
  if (code === "cancelled") {
    return { ok: false, error: { code, message: category, details: {} } } as ConnectionRpcResult<T>;
  }
  return { ok: false, error: { code: "internal", message: category, details: {} } } as ConnectionRpcResult<T>;
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

function responseDiagnostic(response: Response, responseBytes?: number): Pick<TtsFailureDiagnostic, "responseContentType" | "responseBytes" | "requestId"> {
  const responseContentType = response.headers.get("content-type")?.slice(0, 128);
  const requestId = (
    response.headers.get("x-tt-logid")
    ?? response.headers.get("x-request-id")
    ?? response.headers.get("x-api-request-id")
  )?.slice(0, 256);
  return {
    ...(responseContentType ? { responseContentType } : {}),
    ...(responseBytes === undefined ? {} : { responseBytes }),
    ...(requestId ? { requestId } : {})
  };
}

async function httpProviderRejection(
  response: Response,
  profile: Pick<TtsProfile, "provider" | "voice">
): Promise<TtsGatewayError> {
  let responseBytes: number | undefined;
  try {
    const body = await readBoundedResponse(response, MAX_PROVIDER_JSON_BYTES);
    responseBytes = body.byteLength;
  } catch {
    // The HTTP status still provides a safe diagnostic when the body is absent or oversized.
  }
  return new TtsGatewayError("provider-rejected", providerDiagnostic(profile, "http", {
    httpStatus: response.status,
    ...responseDiagnostic(response, responseBytes)
  }));
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

function requestFromPayload(payload: unknown): KeposTtsSynthesisRequest {
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
    throw new TtsGatewayError("provider-rejected", providerDiagnostic({ provider: "alibaba", voice }, "network"));
  }
  if (!response.ok) throw await httpProviderRejection(response, { provider: "alibaba", voice });

  let body: unknown;
  let responseMeta: ReturnType<typeof responseDiagnostic> = responseDiagnostic(response);
  try {
    const encoded = await readBoundedResponse(response, MAX_PROVIDER_JSON_BYTES);
    responseMeta = responseDiagnostic(response, encoded.byteLength);
    body = JSON.parse(new TextDecoder().decode(encoded));
  } catch {
    throw new TtsGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "alibaba", voice }, "provider-response", responseMeta));
  }
  const audio = providerAudio(body);
  if (!audio) throw new TtsGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "alibaba", voice }, "provider-response", responseMeta));
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
      throw new TtsGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "alibaba", voice }, "provider-response"));
    }
  }
  if (!bytes || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
    throw new TtsGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "alibaba", voice }, "provider-response"));
  }
  return bytes;
}

interface ByteDanceFrame {
  code: number;
  data?: string;
}

type ByteDanceResponseIssue = NonNullable<TtsFailureDiagnostic["responseIssue"]>;
type ByteDanceFrameResult =
  | { ok: true; frames: ByteDanceFrame[] }
  | { ok: false; issue: Exclude<ByteDanceResponseIssue, "read-failed"> };

function asFrame(value: unknown): ByteDanceFrame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const header = typeof record.header === "object" && record.header !== null && !Array.isArray(record.header)
    ? record.header as Record<string, unknown>
    : undefined;
  if ("code" in record && typeof record.code !== "number") return undefined;
  if ("data" in record && record.data !== null && typeof record.data !== "string") return undefined;
  if ("message" in record && typeof record.message !== "string") return undefined;
  if (header && "code" in header && typeof header.code !== "number") return undefined;
  if (header && "message" in header && typeof header.message !== "string") return undefined;
  const code = typeof record.code === "number" ? record.code : typeof header?.code === "number" ? header.code : undefined;
  const data = typeof record.data === "string" ? record.data : undefined;
  if (code === undefined) return undefined;
  return { code, ...(data === undefined ? {} : { data }) };
}

/** Parse the domestic one-shot endpoint's SSE `data:` frames. */
function parseByteDanceFrames(text: string): ByteDanceFrameResult {
  const frames: ByteDanceFrame[] = [];
  let sawData = false;
  for (const line of text.split(/\r?\n/)) {
    const item = line.trim();
    if (!item) continue;
    if (item.startsWith(":") || item.startsWith("event:") || item.startsWith("id:") || item.startsWith("retry:")) continue;
    if (!item.startsWith("data:")) return { ok: false, issue: "invalid-frame" };
    const json = item.slice("data:".length).trim();
    if (!json || json === "[DONE]") continue;
    sawData = true;
    try {
      const frame = asFrame(JSON.parse(json));
      if (!frame) return { ok: false, issue: "invalid-frame" };
      frames.push(frame);
    } catch {
      return { ok: false, issue: "invalid-json" };
    }
  }
  return frames.length > 0
    ? { ok: true, frames }
    : { ok: false, issue: sawData ? "invalid-frame" : "no-data-frames" };
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
        accept: "text/event-stream",
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
    throw new TtsGatewayError("provider-rejected", providerDiagnostic({ provider: "bytedance", voice }, "network"));
  }
  if (!response.ok) throw await httpProviderRejection(response, { provider: "bytedance", voice });

  let parsed: ByteDanceFrameResult | { ok: false; issue: "read-failed" };
  let responseMeta: ReturnType<typeof responseDiagnostic> = responseDiagnostic(response);
  try {
    const encoded = await readBoundedResponse(response, MAX_PROVIDER_JSON_BYTES);
    responseMeta = responseDiagnostic(response, encoded.byteLength);
    parsed = parseByteDanceFrames(new TextDecoder().decode(encoded));
  } catch {
    parsed = { ok: false, issue: "read-failed" };
  }
  if (!parsed.ok) throw new TtsGatewayError("provider-invalid-audio", providerDiagnostic(
    { provider: "bytedance", voice },
    "provider-response",
    { ...responseMeta, responseIssue: parsed.issue }
  ));

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const frame of parsed.frames) {
    if (frame.code === 0) {
      if (frame.data !== undefined) {
        const bytes = base64ToBytes(frame.data);
        if (!bytes || total + bytes.length > MAX_AUDIO_BYTES) {
          throw new TtsGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "bytedance", voice }, "provider-response", responseMeta));
        }
        if (bytes.length > 0) {
          chunks.push(bytes);
          total += bytes.length;
        }
      }
      continue;
    }
    if (frame.code === 20_000_000) continue;
    throw new TtsGatewayError("provider-rejected", providerDiagnostic(
      { provider: "bytedance", voice },
      "provider-response",
      responseMeta
    ));
  }
  if (total === 0) throw new TtsGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "bytedance", voice }, "provider-response", responseMeta));
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

  private async generateAndCache(path: string, text: string, profile: TtsProfile): Promise<number> {
    // This disk check wins a race with another process that published the same
    // deterministic artifact while this request was being scheduled.
    const existing = await readAudioArtifactMetadata(path, MAX_AUDIO_BYTES);
    if (existing) return existing.size;
    const credential = await this.options.credentials.resolve(credentialRef(profile.credentialRef));
    if (!credential?.value) throw new TtsGatewayError("unavailable", providerDiagnostic(profile, "credential"));
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

  private async resolveArtifact(payload: unknown, signal?: AbortSignal): Promise<{
    request: KeposTtsSynthesisRequest;
    digest: string;
    path: string;
    size: number;
  }> {
    if (signal?.aborted) throw new TtsGatewayError("cancelled");
    const request = requestFromPayload(payload);
    const settings = this.options.getSettings();
    const profile = profileFromSettings(settings);
    const workspace = resolveSessionWorkspace(this.options.sessions, request.sessionId);
    if (!workspace) throw new TtsGatewayError("unavailable", providerDiagnostic(profile, "session"));
    const digest = cacheDigest(request.text, settings, CACHE_FORMAT_VERSION);
    const path = audioArtifactPath(workspace, digest);
    // The provider request intentionally does not receive the caller signal:
    // once admitted, generation must finish so another occurrence can reuse it.
    const size = await this.artifact(path, request.text, profile);
    return { request, digest, path, size };
  }

  async synthesize(payload: unknown, signal?: AbortSignal): Promise<BrowserAudioPayload> {
    const { request, digest, size } = await this.resolveArtifact(payload, signal);
    return {
      mediaType: "audio/mpeg",
      url: audioUrl(request.sessionId, digest),
      bytes: size
    };
  }

  /**
   * Synthesize one bounded MP3 for an in-process Host consumer. The returned
   * value deliberately contains bytes only; browser URLs and cache paths stay
   * behind the Kepos-owned browser and filesystem seams.
   */
  async synthesizeBytes(payload: unknown, signal?: AbortSignal): Promise<KeposTtsAudio> {
    try {
      const { path } = await this.resolveArtifact(payload, signal);
      const data = await readAudioArtifact(path, MAX_AUDIO_BYTES);
      if (!data) throw new TtsGatewayError("internal");
      return { mediaType: "audio/mpeg", data };
    } catch (error) {
      if (error instanceof TtsGatewayError) throw error;
      throw new TtsGatewayError("internal");
    }
  }

  async handle(endpoint: string, payload: unknown, signal: AbortSignal): Promise<ConnectionRpcResult<BrowserAudioPayload>> {
    if (endpoint !== RPC_ENDPOINT) return failure("invalid-input");
    try {
      return { ok: true, value: await this.synthesize(payload, signal) };
    } catch (error) {
      const category = error instanceof TtsGatewayError ? error.category : "internal";
      if (category !== "invalid-input" && category !== "cancelled") {
        try {
          this.options.onFailure?.({
            category,
            ...(error instanceof TtsGatewayError ? error.diagnostic : {})
          });
        } catch {
          // Observability must not change the RPC result.
        }
      }
      return failure(category);
    }
  }
}

export function createTtsRpcHandler(gateway: TtsGateway): ConnectionRpcHandler {
  return (endpoint, payload, signal) => gateway.handle(endpoint, payload, signal);
}

/** Build the optional Cordis Host service from the shared gateway. */
export function createKeposTtsService(gateway: TtsGateway): KeposTtsService {
  return {
    synthesize: (request, signal) => gateway.synthesizeBytes(request, signal)
  };
}

export function registerTtsRpc(
  connection: Pick<HostConnectionRpc, "handle">,
  gateway: TtsGateway
): () => Promise<void> {
  return connection.handle(RPC_CHANNEL, createTtsRpcHandler(gateway));
}
