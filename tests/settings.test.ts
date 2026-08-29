import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { CREDENTIAL_REF, DEFAULT_VOICE, VOICE_LABELS, normalizeSettings } from "../src/settings.js";
import { TtsSettingsCard, describeCredential, decodeSettings, removeCredential, saveCredential, type ClientSettingsScope } from "../src/client/settings-card.js";

function scope(value: Partial<{ voice: "onoAnna" | "maia" | "momo" }> = {}): ClientSettingsScope {
  return {
    getSnapshot: () => ({ status: "ready", value, base: undefined, user: undefined, revision: 1, writable: true, mode: "host" }),
    subscribe: () => () => undefined,
    set: async () => undefined,
    unset: async () => undefined
  };
}

describe("settings and credentials surface", () => {
  it("defaults unknown settings to Ono Anna and decodes persisted alternatives", () => {
    expect(normalizeSettings(undefined).voice).toBe(DEFAULT_VOICE);
    expect(decodeSettings({ voice: "maia" }).voice).toBe("maia");
    expect(decodeSettings({ voice: "unsupported" }).voice).toBe(DEFAULT_VOICE);
    expect(VOICE_LABELS.momo).toBe("Momo");
  });

  it("describes credentials without accepting or exposing a secret value", async () => {
    const calls: unknown[] = [];
    const writes: unknown[] = [];
    const api = {
      credentials: {
        describe: async (payload: unknown) => { calls.push(payload); return { result: { ok: true, value: { credentials: { [CREDENTIAL_REF]: { configured: true, source: "file", writable: true } } } } }; },
        set: async (payload: unknown) => { writes.push(["set", payload]); return { result: { ok: true, value: {} } }; },
        unset: async (payload: unknown) => { writes.push(["unset", payload]); return { result: { ok: true, value: {} } }; }
      }
    };
    await expect(describeCredential(api)).resolves.toEqual({ configured: true, source: "file", writable: true });
    expect(calls).toEqual([{ refs: [CREDENTIAL_REF] }]);
    await saveCredential(api, "new-secret");
    await removeCredential(api);
    expect(writes).toEqual([["set", { ref: CREDENTIAL_REF, value: "new-secret" }], ["unset", { ref: CREDENTIAL_REF }]]);
    const html = renderToStaticMarkup(createElement(TtsSettingsCard, { scope: scope({ voice: "maia" }), api }));
    expect(html).toContain(VOICE_LABELS.maia);
    expect(html).not.toContain("secret");
  });
});
