import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CREDENTIAL_REF,
  QWEN_MODEL,
  VOICE_LABELS,
  VOICE_IDS,
  type VoiceId
} from "../src/settings.js";
import {
  AUDIO_ROUTE_PATH,
  QwenTtsGateway,
  RPC_ENDPOINT,
  TtsGatewayError,
  audioArtifactPath,
  cacheDigest,
  serveTtsAudio,
  type BrowserAudioPayload
} from "../src/gateway.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sessionStore(cwd: string, id = "session-a") {
  return { get: (candidate: string) => candidate === id ? { header: { cwd } } : undefined };
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kepos-tts-gateway-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Qwen gateway", () => {
  it("maps every approved setting to fixed non-streaming Chinese MP3 input and caches it", async () => {
    const cwd = await workspace();
    expect(cacheDigest("  你好\n", "onoAnna")).toBe(cacheDigest("你好", "onoAnna"));
    const requests: Array<{ body: any; authorization: string }> = [];
    let current: VoiceId = "onoAnna";
    const fakeFetch: typeof fetch = async (_url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)), authorization: String(new Headers(init?.headers).get("authorization")) });
      return response({ output: { audio: { data: "SUQz" } } });
    };
    const gateway = new QwenTtsGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async (ref) => ({ value: ref === CREDENTIAL_REF ? "secret" : "wrong", source: "test" }) },
      getVoice: () => current,
      fetch: fakeFetch
    });
    for (const voice of VOICE_IDS) {
      current = voice;
      const audio = await gateway.synthesize({ sessionId: "session-a", text: "你好" });
      expect(audio.mediaType).toBe("audio/mpeg");
      expect(audio.url).toContain(`${AUDIO_ROUTE_PATH}/`);
      expect(audio.url).not.toContain("base64");
      expect(audio).not.toHaveProperty("data");
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

  it("reuses one workspace artifact across gateway instances without another provider request", async () => {
    const cwd = await workspace();
    let calls = 0;
    const makeGateway = (fetch: typeof globalThis.fetch) => new QwenTtsGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "secret", source: "test" }) },
      getVoice: () => "onoAnna",
      fetch
    });
    const first = makeGateway(async () => {
      calls += 1;
      return response({ output: { audio: { data: "SUQz" } } });
    });
    const expected = await first.synthesize({ sessionId: "session-a", text: "缓存" });
    const second = makeGateway(async () => {
      calls += 1;
      throw new Error("provider must not be contacted for a cache hit");
    });
    await expect(second.synthesize({ sessionId: "session-a", text: "缓存" })).resolves.toEqual(expected);
    expect(calls).toBe(1);
    await expect(readFile(audioArtifactPath(cwd, cacheDigest("缓存", "onoAnna")))).resolves.toEqual(Buffer.from([0x49, 0x44, 0x33]));
  });

  it("coalesces concurrent identical misses and keeps different keys independent", async () => {
    const cwd = await workspace();
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let current: VoiceId = "onoAnna";
    const gateway = new QwenTtsGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "secret", source: "test" }) },
      getVoice: () => current,
      fetch: async () => {
        calls += 1;
        await held;
        return response({ output: { audio: { data: "SUQz" } } });
      }
    });
    const one = gateway.synthesize({ sessionId: "session-a", text: "并发" });
    const two = gateway.synthesize({ sessionId: "session-a", text: "并发" });
    await vi.waitFor(() => expect(calls).toBe(1));
    release();
    await expect(Promise.all([one, two])).resolves.toHaveLength(2);
    current = "maia";
    await gateway.synthesize({ sessionId: "session-a", text: "并发" });
    await gateway.synthesize({ sessionId: "session-a", text: "另一句" });
    expect(calls).toBe(3);
  });

  it("resolves the named credential per miss and rejects invalid input or unavailable sessions", async () => {
    const cwd = await workspace();
    const refs: unknown[] = [];
    const gateway = new QwenTtsGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async (ref) => { refs.push(ref); return { value: "secret", source: "test" }; } },
      getVoice: () => "onoAnna",
      fetch: async () => response({ output: { audio: { data: "SUQz" } } })
    });
    await gateway.synthesize({ sessionId: "session-a", text: "一" });
    expect(refs).toEqual([CREDENTIAL_REF]);
    await expect(gateway.synthesize({ text: "缺身份" })).rejects.toMatchObject({ category: "invalid-input" });
    await expect(gateway.synthesize({ sessionId: "missing", text: "缺会话" })).rejects.toMatchObject({ category: "unavailable" });
    await expect(gateway.synthesize({ sessionId: "session-a", text: "   " })).rejects.toMatchObject({ category: "invalid-input" });
    await expect(gateway.synthesize({ sessionId: "session-a", text: "x", voice: "Maia" })).rejects.toMatchObject({ category: "invalid-input" });
    await expect(gateway.synthesize({ sessionId: "session-a", text: "你".repeat(241) })).rejects.toMatchObject({ category: "invalid-input" });
  });

  it("returns non-sensitive provider and malformed-audio failures", async () => {
    const cwd = await workspace();
    const base = { sessions: sessionStore(cwd), credentials: { resolve: async () => ({ value: "secret", source: "test" }) }, getVoice: () => "onoAnna" };
    const rejected = new QwenTtsGateway({ ...base, fetch: async () => response({ error: "do not expose" }, 403) });
    await expect(rejected.handle(RPC_ENDPOINT, { sessionId: "session-a", text: "你好" }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { message: "provider-rejected" } });
    const malformed = new QwenTtsGateway({ ...base, fetch: async () => response({ output: { audio: { data: "not base64!" } } }) });
    await expect(malformed.synthesize({ sessionId: "session-a", text: "你好" })).rejects.toBeInstanceOf(TtsGatewayError);
    await expect(malformed.synthesize({ sessionId: "session-a", text: "你好" })).rejects.toMatchObject({ category: "provider-invalid-audio" });
  });

  it("downloads URL audio when the provider leaves data empty", async () => {
    const cwd = await workspace();
    let calls = 0;
    const gateway = new QwenTtsGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "secret", source: "test" }) },
      getVoice: () => "onoAnna",
      fetch: async (url) => {
        calls += 1;
        return calls === 1 ? response({ output: { audio: { url: "https://audio.example/clip.mp3", data: "" } } }) : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
      }
    });
    const result: BrowserAudioPayload = await gateway.synthesize({ sessionId: "session-a", text: "播放" });
    expect(result).toMatchObject({ mediaType: "audio/mpeg", bytes: 3 });
    expect(result.url).toMatch(/\/kepos-tts\/audio\/[a-f0-9]{64}\.mp3\?sessionId=session-a/);
    expect(calls).toBe(2);
  });

  it("serves only the resolved workspace digest and reports useful metadata", async () => {
    const cwd = await workspace();
    const gateway = new QwenTtsGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "secret", source: "test" }) },
      getVoice: () => "onoAnna",
      fetch: async () => response({ output: { audio: { data: "SUQz" } } })
    });
    const payload = await gateway.synthesize({ sessionId: "session-a", text: "路由" });
    const captured: { status?: number; headers?: Record<string, string> | undefined; body?: unknown } = {};
    const res = {
      writeHead(status: number, headers?: Record<string, string>) { captured.status = status; captured.headers = headers; },
      end(body?: unknown) { captured.body = body; }
    };
    await serveTtsAudio({ method: "GET", url: payload.url }, res, sessionStore(cwd));
    expect(captured.status).toBe(200);
    expect(captured.headers).toMatchObject({ "content-type": "audio/mpeg", "content-length": "3" });
    expect(captured.body).toEqual(new Uint8Array([0x49, 0x44, 0x33]));

    for (const url of [
      `${AUDIO_ROUTE_PATH}/../secret.mp3?sessionId=session-a`,
      `${AUDIO_ROUTE_PATH}/bad.mp3?sessionId=session-a`,
      `${AUDIO_ROUTE_PATH}/${"0".repeat(64)}.mp3?sessionId=missing`,
      `${AUDIO_ROUTE_PATH}/${"0".repeat(64)}.mp3?sessionId=session-a`
    ]) {
      const failed: { status?: number } = {};
      await serveTtsAudio({ method: "GET", url }, { writeHead: (status) => { failed.status = status; }, end: () => undefined }, sessionStore(cwd));
      expect(failed.status).toBe(404);
    }
  });
});
