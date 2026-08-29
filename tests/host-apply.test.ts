import { describe, expect, it } from "vitest";

import { apply, inject, name } from "../src/index.js";
import { RPC_CHANNEL, RPC_ENDPOINT } from "../src/gateway.js";
import { CREDENTIAL_REF, SETTINGS_NAMESPACE, TTS_SYSTEM_PROMPT } from "../src/core.js";

describe("host plugin composition", () => {
  it("registers native settings, static prompt, and a trusted sole RPC channel", () => {
    const handleCalls: unknown[][] = [];
    const sectionCalls: unknown[] = [];
    const registerCalls: unknown[][] = [];
    const handle = (...args: unknown[]) => { handleCalls.push(args); return async () => undefined; };
    const section = (value: unknown) => { sectionCalls.push(value); return () => undefined; };
    const register = (...args: unknown[]) => { registerCalls.push(args); return { get: () => ({ voice: "onoAnna" }) }; };
    apply({
      settings: { register },
      credentials: { resolve: async (ref: unknown) => ref === CREDENTIAL_REF ? { value: "secret", source: "test" } : undefined },
      connection: { rpc: { handle } },
      systemPrompt: { section }
    } as never);
    expect(name).toBe("kepos-tts");
    expect(inject).toEqual(["connection", "credentials", "settings", "systemPrompt"]);
    expect(registerCalls[0]).toEqual([SETTINGS_NAMESPACE, expect.anything(), { base: { voice: "onoAnna" }, applies: "live" }]);
    expect(sectionCalls[0]).toEqual(expect.objectContaining({ name: "kepos-tts:tagged-output", text: TTS_SYSTEM_PROMPT }));
    expect(handleCalls[0]).toEqual([RPC_CHANNEL, expect.any(Function), { authority: "trusted-host" }]);
    const handler = handleCalls[0]![1] as (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;
    expect(RPC_ENDPOINT).toBe("synthesize");
    return expect(handler("other", { text: "你好" }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { message: "invalid-input" } });
  });
});
