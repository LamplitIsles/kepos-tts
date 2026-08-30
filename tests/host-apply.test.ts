import { describe, expect, it, vi } from "vitest";

import { apply, inject, name } from "../src/index.js";
import { RPC_CHANNEL, RPC_ENDPOINT } from "../src/gateway.js";
import { ALIBABA_CREDENTIAL_REF, DEFAULT_ALIBABA_VOICE, DEFAULT_BYTEDANCE_VOICE, DEFAULT_PROVIDER, SETTINGS_NAMESPACE, TTS_SYSTEM_PROMPT } from "../src/core.js";

describe("host plugin composition", () => {
  it("registers native settings, static prompt, a trusted sole RPC channel, and Cordis failure logging", async () => {
    const handleCalls: unknown[][] = [];
    const sectionCalls: unknown[] = [];
    const registerCalls: unknown[][] = [];
    const routeCalls: unknown[] = [];
    const warn = vi.fn();
    const handle = (...args: unknown[]) => { handleCalls.push(args); return async () => undefined; };
    const section = (value: unknown) => { sectionCalls.push(value); return () => undefined; };
    const register = (...args: unknown[]) => { registerCalls.push(args); return { get: () => ({ provider: DEFAULT_PROVIDER, alibabaVoice: DEFAULT_ALIBABA_VOICE, bytedanceVoice: DEFAULT_BYTEDANCE_VOICE }) }; };
    const webServer = { register: (route: unknown) => { routeCalls.push(route); return () => undefined; } };
    const effect = (callback: () => (() => void)) => callback();
    apply({
      settings: { register },
      credentials: { resolve: async (ref: unknown) => ref === ALIBABA_CREDENTIAL_REF ? { value: "secret", source: "test" } : undefined },
      connection: { rpc: { handle } },
      systemPrompt: { section },
      sessions: { get: () => undefined },
      webServer,
      logger: { warn },
      effect
    } as never);
    expect(name).toBe("kepos-tts");
    expect(inject).toEqual(["connection", "credentials", "settings", "systemPrompt", "sessions", "webServer"]);
    expect(registerCalls[0]).toEqual([SETTINGS_NAMESPACE, expect.anything(), { base: { provider: DEFAULT_PROVIDER, alibabaVoice: DEFAULT_ALIBABA_VOICE, bytedanceVoice: DEFAULT_BYTEDANCE_VOICE }, applies: "live" }]);
    expect(sectionCalls[0]).toEqual(expect.objectContaining({ name: "kepos-tts:tagged-output", text: TTS_SYSTEM_PROMPT }));
    expect(handleCalls[0]).toEqual([RPC_CHANNEL, expect.any(Function), { authority: "trusted-host" }]);
    expect(routeCalls[0]).toEqual(expect.objectContaining({ kind: "prefix", path: "/kepos-tts/audio", handler: expect.any(Function) }));
    const handler = handleCalls[0]![1] as (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;
    expect(RPC_ENDPOINT).toBe("synthesize");
    await expect(handler("other", { text: "你好" }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { message: "invalid-input" } });
    await expect(handler(RPC_ENDPOINT, { text: "你好", sessionId: "missing-session" }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { message: "unavailable" } });
    expect(warn).toHaveBeenCalledWith("synthesis failed: %o", expect.objectContaining({ category: "unavailable" }));
  });
});
