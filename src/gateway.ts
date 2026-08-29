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
import { RPC_CHANNEL, RPC_ENDPOINT, type BrowserAudioPayload } from "./rpc.js";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export type TtsFailureCategory =
  | "invalid-input"
  | "unavailable"
  | "provider-rejected"
  | "provider-invalid-audio"
  | "internal"
  | "cancelled";

export { RPC_CHANNEL, RPC_ENDPOINT } from "./rpc.js";
export type { BrowserAudioPayload } from "./rpc.js";

export interface CredentialResolver {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<ResolvedCredential | undefined>;
}

export interface TtsGatewayOptions {
  credentials: CredentialResolver | Pick<CredentialProvider, "resolve">;
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

function bytesToBase64(bytes: Uint8Array): string {
  const buffer = (globalThis as { Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (buffer) return buffer.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
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

function textFromPayload(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TtsGatewayError("invalid-input");
  }
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "text") throw new TtsGatewayError("invalid-input");
  const text = (payload as { text?: unknown }).text;
  if (typeof text !== "string") throw new TtsGatewayError("invalid-input");
  const normalized = text.replace(/[\s\u00a0]+/gu, " ").trim();
  if (!normalized || Array.from(normalized).length > TTS_MAX_CHARS) throw new TtsGatewayError("invalid-input");
  return normalized;
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

export class QwenTtsGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(private readonly options: TtsGatewayOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.endpoint = DASHSCOPE_ENDPOINT;
  }

  async synthesize(payload: unknown, signal?: AbortSignal): Promise<BrowserAudioPayload> {
    if (signal?.aborted) throw new TtsGatewayError("cancelled");
    const text = textFromPayload(payload);
    const credential = await this.options.credentials.resolve(credentialRef(CREDENTIAL_REF));
    if (!credential?.value) throw new TtsGatewayError("unavailable");
    const voice = normalizeVoice(this.options.getVoice());
    let response: Response;
    try {
      const request: RequestInit = {
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
      };
      if (signal) request.signal = signal;
      response = await this.fetchImpl(this.endpoint, request);
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new TtsGatewayError("cancelled");
      }
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
        const request: RequestInit = { method: "GET" };
        if (signal) request.signal = signal;
        const audioResponse = await this.fetchImpl(url.toString(), request);
        if (!audioResponse.ok) throw new Error("status");
        const contentType = typeof audioResponse.headers?.get === "function" ? audioResponse.headers.get("content-type") : "";
        if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") throw new Error("content-type");
        bytes = asBytes(await audioResponse.arrayBuffer());
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          throw new TtsGatewayError("cancelled");
        }
        throw new TtsGatewayError("provider-invalid-audio");
      }
    }
    if (!bytes || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
      throw new TtsGatewayError("provider-invalid-audio");
    }
    return { mediaType: "audio/mpeg", data: bytesToBase64(bytes), bytes: bytes.length };
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
