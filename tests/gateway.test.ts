import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_REF,
  QWEN_MODEL,
  VOICE_LABELS,
  VOICE_IDS,
  type VoiceId
} from "../src/settings.js";
import {
  QwenTtsGateway,
  RPC_ENDPOINT,
  TtsGatewayError,
  type BrowserAudioPayload
} from "../src/gateway.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Qwen gateway", () => {
  it("maps every approved setting to fixed non-streaming Chinese MP3 input", async () => {
    const requests: Array<{ body: any; authorization: string }> = [];
    let current: VoiceId = "onoAnna";
    const fakeFetch: typeof fetch = async (_url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)), authorization: String(new Headers(init?.headers).get("authorization")) });
      return response({ output: { audio: { data: "SUQz" } } });
    };
    const gateway = new QwenTtsGateway({
      credentials: { resolve: async (ref) => ({ value: ref === CREDENTIAL_REF ? "secret" : "wrong", source: "test" }) },
      getVoice: () => current,
      fetch: fakeFetch
    });
    for (const voice of VOICE_IDS) {
      current = voice;
      const audio = await gateway.synthesize({ text: "你好" });
      expect(audio.mediaType).toBe("audio/mpeg");
      expect(audio.data).toBe("SUQz");
    }
    expect(requests).toHaveLength(3);
    for (const [index, request] of requests.entries()) {
      expect(request.authorization).toBe("Bearer secret");
      expect(request.body).toMatchObject({
        model: QWEN_MODEL,
        input: { text: "你好", voice: VOICE_LABELS[VOICE_IDS[index]!], language_type: "Chinese" },
        parameters: { format: "mp3" },
        stream: false
      });
    }
  });

  it("resolves the named credential for each request and rejects invalid input", async () => {
    const refs: string[] = [];
    let configured = true;
    const gateway = new QwenTtsGateway({
      credentials: { resolve: async (ref) => { refs.push(ref); return configured ? { value: "secret", source: "test" } : undefined; } },
      getVoice: () => "onoAnna",
      fetch: async () => response({ output: { audio: { data: "SUQz" } } })
    });
    await gateway.synthesize({ text: "一" });
    await gateway.synthesize({ text: "二" });
    expect(refs).toEqual([CREDENTIAL_REF, CREDENTIAL_REF]);
    configured = false;
    await expect(gateway.synthesize({ text: "三" })).rejects.toMatchObject({ category: "unavailable" });
    await expect(gateway.synthesize({ text: "   " })).rejects.toMatchObject({ category: "invalid-input" });
    await expect(gateway.synthesize({ text: "x", voice: "Maia" })).rejects.toMatchObject({ category: "invalid-input" });
    await expect(gateway.synthesize({ text: "你".repeat(241) })).rejects.toMatchObject({ category: "invalid-input" });
  });

  it("returns non-sensitive failure categories for provider and malformed audio errors", async () => {
    const base = { credentials: { resolve: async () => ({ value: "secret", source: "test" }) }, getVoice: () => "onoAnna" };
    const rejected = new QwenTtsGateway({ ...base, fetch: async () => response({ error: "do not expose" }, 403) });
    await expect(rejected.handle(RPC_ENDPOINT, { text: "你好" }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { message: "provider-rejected" } });
    const malformed = new QwenTtsGateway({ ...base, fetch: async () => response({ output: { audio: { data: "not base64!" } } }) });
    await expect(malformed.synthesize({ text: "你好" })).rejects.toBeInstanceOf(TtsGatewayError);
    await expect(malformed.synthesize({ text: "你好" })).rejects.toMatchObject({ category: "provider-invalid-audio" });
  });

  it("downloads URL audio when the provider leaves data empty", async () => {
    let calls = 0;
    const gateway = new QwenTtsGateway({
      credentials: { resolve: async () => ({ value: "secret", source: "test" }) },
      getVoice: () => "onoAnna",
      fetch: async (url) => {
        calls += 1;
        return calls === 1 ? response({ output: { audio: { url: "https://audio.example/clip.mp3", data: "" } } }) : new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
    });
    const result: BrowserAudioPayload = await gateway.synthesize({ text: "播放" });
    expect(result).toMatchObject({ mediaType: "audio/mpeg", data: "AQID", bytes: 3 });
    expect(calls).toBe(2);
  });
});
