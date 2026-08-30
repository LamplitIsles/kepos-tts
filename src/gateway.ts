import { credentialRef, type CredentialProvider, type ResolvedCredential } from "@deepseek-ai/dsh-credentials";
import type { HostConnectionRpc, ConnectionRpcHandler } from "@deepseek-ai/dsh-client-connection";
import type { RpcResult } from "@deepseek-ai/dsh-host-apiproxy/api";

import {
  CREDENTIAL_REF,
  DASHSCOPE_ENDPOINT,
  QWEN_MODEL,
  TTS_MAX_CHARS,
  VOICE_LABELS,
  normalizeVoice
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
  getVoice: () => unknown;
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

function asBytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value);
}

function base64ToBytes(value: string): Uint8Array | undefined {
  const dataUri = value.match(/^data:[^;,]+;base64,(.*)$/s);
  if (dataUri) value = dataUri[1]!;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
  try {
    const buffer = (globalThis as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;
    if (buffer) return new Uint8Array(buffer.from(value, "base64"));
    const decoded = atob(value);
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

async function providerBytes(
  fetchImpl: typeof fetch,
  credential: ResolvedCredential,
  text: string,
  voice: keyof typeof VOICE_LABELS
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
        model: QWEN_MODEL,
        input: { text, voice: VOICE_LABELS[voice], language_type: "Chinese" },
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
    body = await response.json();
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
      bytes = asBytes(await audioResponse.arrayBuffer());
    } catch {
      throw new TtsGatewayError("provider-invalid-audio");
    }
  }
  if (!bytes || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
    throw new TtsGatewayError("provider-invalid-audio");
  }
  return bytes;
}

/** Shared in-flight work survives individual gateway instances and renderer disposal. */
const inFlight = new Map<string, Promise<number>>();

export class QwenTtsGateway {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TtsGatewayOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async generateAndCache(path: string, text: string, voice: keyof typeof VOICE_LABELS): Promise<number> {
    // This disk check wins a race with another process that published the same
    // deterministic artifact while this request was being scheduled.
    const existing = await readAudioArtifactMetadata(path, MAX_AUDIO_BYTES);
    if (existing) return existing.size;
    const credential = await this.options.credentials.resolve(credentialRef(CREDENTIAL_REF));
    if (!credential?.value) throw new TtsGatewayError("unavailable");
    const bytes = await providerBytes(this.fetchImpl, credential, text, voice);
    await writeAudioArtifactAtomic(path, bytes, MAX_AUDIO_BYTES);
    return bytes.byteLength;
  }

  private async artifact(path: string, text: string, voice: keyof typeof VOICE_LABELS): Promise<number> {
    const pending = inFlight.get(path);
    if (pending) return pending;
    // Keep the in-flight entry from the initial disk lookup onward. This
    // closes the small race where identical callers both observe a miss before
    // either provider request has started.
    const generation = this.generateAndCache(path, text, voice);
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
    const voice = normalizeVoice(this.options.getVoice()) as keyof typeof VOICE_LABELS;
    const workspace = resolveSessionWorkspace(this.options.sessions, request.sessionId);
    if (!workspace) throw new TtsGatewayError("unavailable");
    const digest = cacheDigest(request.text, voice, CACHE_FORMAT_VERSION);
    const path = audioArtifactPath(workspace, digest);
    // The provider request intentionally does not receive the browser signal:
    // once admitted, generation must finish so another occurrence can reuse it.
    const bytes = await this.artifact(path, request.text, voice);
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

export function createTtsRpcHandler(gateway: QwenTtsGateway): ConnectionRpcHandler {
  return (endpoint, payload, signal) => gateway.handle(endpoint, payload, signal);
}

export function registerTtsRpc(
  connection: Pick<HostConnectionRpc, "handle">,
  gateway: QwenTtsGateway
): () => Promise<void> {
  return connection.handle(RPC_CHANNEL, createTtsRpcHandler(gateway), { authority: "trusted-host" });
}
