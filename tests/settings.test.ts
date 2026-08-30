import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { act, create } from "react-test-renderer";

import { CREDENTIAL_REF, DEFAULT_VOICE, VOICE_LABELS, normalizeSettings } from "../src/settings.js";
import { TtsSettingsCard, describeCredential, decodeSettings, saveCredential, type ClientSettingsScope } from "../src/client/settings-card.js";

function scope(value: Partial<{ voice: "onoAnna" | "maia" | "momo" }> = {}): ClientSettingsScope {
  return {
    getSnapshot: () => ({ status: "ready", value, base: undefined, user: undefined, revision: 1, writable: true, mode: "host" }),
    subscribe: () => () => undefined,
    set: async () => undefined,
    unset: async () => undefined
  };
}

function controlledScope(initial: Partial<{ voice: "onoAnna" | "maia" | "momo" }> = {}, writable = true) {
  let snapshot = {
    status: "ready" as const,
    value: { ...initial },
    base: undefined,
    user: undefined,
    revision: 1,
    writable,
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

const apiFor = (configured = false, writable = true, writes: unknown[] = []) => ({
  credentials: {
    describe: async () => ({ result: { ok: true, value: { credentials: { [CREDENTIAL_REF]: { configured, source: "file", writable } } } } }),
    set: async (payload: unknown) => { writes.push(["set", payload]); return { result: { ok: true, value: {} } }; }
  }
});

describe("native-shaped settings card", () => {
  it("defaults unknown settings and starts as a collapsed disclosure card", () => {
    expect(normalizeSettings(undefined).voice).toBe(DEFAULT_VOICE);
    expect(decodeSettings({ voice: "maia" }).voice).toBe("maia");
    expect(decodeSettings({ voice: "unsupported" }).voice).toBe(DEFAULT_VOICE);
    expect(VOICE_LABELS.momo).toBe("Momo");
    const html = renderToStaticMarkup(createElement(TtsSettingsCard, { scope: scope({ voice: "maia" }), api: apiFor() }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Qwen voice");
    expect(html).not.toContain("TAGGED SPEECH");
    expect(html).not.toContain("<dl");
    expect(html).not.toContain("<select");
  });

  it("describes credentials without accepting or exposing a secret value", async () => {
    const calls: unknown[] = [];
    const writes: unknown[] = [];
    const api = {
      credentials: {
        describe: async (payload: unknown) => { calls.push(payload); return { result: { ok: true, value: { credentials: { [CREDENTIAL_REF]: { configured: true, source: "file", writable: true } } } } }; },
        set: async (payload: unknown) => { writes.push(["set", payload]); return { result: { ok: true, value: {} } }; }
      }
    };
    await expect(describeCredential(api)).resolves.toEqual({ configured: true, source: "file", writable: true });
    expect(calls).toEqual([{ refs: [CREDENTIAL_REF] }]);
    await saveCredential(api, "new-secret");
    expect(writes).toEqual([["set", { ref: CREDENTIAL_REF, value: "new-secret" }]]);
    const html = renderToStaticMarkup(createElement(TtsSettingsCard, { scope: scope({ voice: "maia" }), api }));
    expect(html).toContain("Qwen voice");
    expect(html).not.toContain("new-secret");
  });

  it("stages voice and key edits and applies both only from Save", async () => {
    const controlled = controlledScope({ voice: "onoAnna" });
    const writes: unknown[] = [];
    const api = apiFor(false, true, writes);
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(TtsSettingsCard, { scope: controlled.settings, api }));
      await Promise.resolve();
    });
    const header = root!.root.findByProps({ "aria-expanded": false });
    await act(async () => { header.props.onClick(); });
    const select = root!.root.findByType("select");
    await act(async () => { select.props.onChange({ target: { value: "maia" } }); });
    expect(controlled.writes).toEqual([]);
    const input = root!.root.findByProps({ type: "password" });
    await act(async () => { input.props.onChange({ target: { value: "saved-secret" } }); });
    expect(controlled.writes).toEqual([]);
    const save = root!.root.findAllByType("button").find((button) => button.props.children === "Save");
    expect(save).toBeDefined();
    await act(async () => { await save!.props.onClick(); });
    expect(controlled.writes).toEqual([["voice", "maia"]]);
    expect(writes).toEqual([["set", { ref: CREDENTIAL_REF, value: "saved-secret" }]]);
    expect(JSON.stringify(root!.toJSON())).not.toContain("saved-secret");
    root!.unmount();
  });

  it("discards staged edits and leaves a configured credential when the key is blank", async () => {
    const controlled = controlledScope({ voice: "onoAnna" });
    const writes: unknown[] = [];
    const api = apiFor(true, true, writes);
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(TtsSettingsCard, { scope: controlled.settings, api }));
      await Promise.resolve();
    });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    const select = root!.root.findByType("select");
    await act(async () => { select.props.onChange({ target: { value: "momo" } }); });
    const discard = root!.root.findAllByType("button").find((button) => button.props.children === "Discard");
    await act(async () => { discard!.props.onClick(); });
    expect(root!.root.findByType("select").props.value).toBe("onoAnna");
    const input = root!.root.findByProps({ type: "password" });
    await act(async () => { input.props.onChange({ target: { value: "" } }); });
    expect(root!.root.findAllByType("button").find((button) => button.props.children === "Save")!.props.disabled).toBe(true);
    expect(writes).toEqual([]);
    root!.unmount();
  });

  it("uses the compact read-only message and disables writes on a remote card", async () => {
    const controlled = controlledScope({ voice: "onoAnna" });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(TtsSettingsCard, { scope: controlled.settings, api: apiFor(true, true), localOnly: false }));
      await Promise.resolve();
    });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    expect(root!.root.findByProps({ role: "status" }).children.join("")).toContain("read-only");
    expect(root!.root.findByType("select").props.disabled).toBe(true);
    expect(root!.root.findByProps({ type: "password" }).props.disabled).toBe(true);
    root!.unmount();
  });

  it("keeps staged values and reports a failed save in the footer", async () => {
    const controlled = controlledScope({ voice: "onoAnna" });
    const api = {
      credentials: {
        describe: async () => ({ result: { ok: true, value: { credentials: { [CREDENTIAL_REF]: { configured: false, writable: true } } } } }),
        set: async () => { throw new Error("no"); }
      }
    };
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(TtsSettingsCard, { scope: controlled.settings, api }));
      await Promise.resolve();
    });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "maia" } }); });
    await act(async () => { root!.root.findByProps({ type: "password" }).props.onChange({ target: { value: "bad-secret" } }); });
    const save = root!.root.findAllByType("button").find((button) => button.props.children === "Save");
    await act(async () => { await save!.props.onClick(); });
    expect(root!.root.findByProps({ role: "status" }).children.join("")).toContain("did not accept");
    expect(root!.root.findByType("select").props.value).toBe("maia");
    root!.unmount();
  });
});
