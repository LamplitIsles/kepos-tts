import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { act, create } from "react-test-renderer";

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

function controlledScope(initial: Partial<{ voice: "onoAnna" | "maia" | "momo" }> = {}) {
  let snapshot = {
    status: "ready" as const,
    value: { ...initial },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: "host" as const
  };
  const listeners = new Set<() => void>();
  const writes: Array<[string, unknown]> = [];
  const settings: ClientSettingsScope = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: async (field, value) => {
      writes.push([field, value]);
      snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value } };
      listeners.forEach((listener) => listener());
    },
    unset: async (field) => {
      writes.push([field, undefined]);
      const value = { ...snapshot.value };
      delete value[field as keyof typeof value];
      snapshot = { ...snapshot, value };
      listeners.forEach((listener) => listener());
    }
  };
  return { settings, writes };
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

  it("persists voice and credential controls through fake DSH interfaces", async () => {
    const controlled = controlledScope({ voice: "onoAnna" });
    let configured = false;
    const writes: unknown[] = [];
    const api = {
      credentials: {
        describe: async () => ({ result: { ok: true, value: { credentials: { [CREDENTIAL_REF]: { configured, source: "file", writable: true } } } } }),
        set: async (payload: unknown) => {
          writes.push(["set", payload]);
          configured = true;
          return { result: { ok: true, value: {} } };
        },
        unset: async (payload: unknown) => {
          writes.push(["unset", payload]);
          configured = false;
          return { result: { ok: true, value: {} } };
        }
      }
    };
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(TtsSettingsCard, { scope: controlled.settings, api }));
      await Promise.resolve();
    });

    const select = root!.root.findByType("select");
    await act(async () => {
      await select.props.onChange({ target: { value: "maia" } });
    });
    expect(controlled.writes).toEqual([["voice", "maia"]]);

    const input = root!.root.findByProps({ type: "password" });
    await act(async () => {
      input.props.onChange({ target: { value: "saved-secret" } });
    });
    const form = root!.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
    });
    expect(writes).toEqual([["set", { ref: CREDENTIAL_REF, value: "saved-secret" }]]);
    expect(JSON.stringify(root!.toJSON())).not.toContain("saved-secret");

    const remove = root!.root.findAllByType("button").find((button) => button.props.children === "Remove key");
    expect(remove).toBeDefined();
    await act(async () => {
      await remove!.props.onClick();
    });
    expect(writes).toEqual([
      ["set", { ref: CREDENTIAL_REF, value: "saved-secret" }],
      ["unset", { ref: CREDENTIAL_REF }]
    ]);
    root!.unmount();
  });

  it("does not expose remote write controls", async () => {
    const controlled = controlledScope();
    const api = {
      credentials: {
        describe: async () => ({ result: { ok: true, value: { credentials: { [CREDENTIAL_REF]: { configured: true, source: "file", writable: true } } } } }),
        set: async () => ({ result: { ok: true, value: {} } }),
        unset: async () => ({ result: { ok: true, value: {} } })
      }
    };
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(TtsSettingsCard, { scope: controlled.settings, api, localOnly: false }));
      await Promise.resolve();
    });
    expect(root!.root.findByType("select").props.disabled).toBe(true);
    expect(root!.root.findAllByProps({ type: "password" })).toHaveLength(0);
    expect(root!.root.findByProps({ "data-writable": "no" })).toBeDefined();
    root!.unmount();
  });
});
