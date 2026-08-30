import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { act, create } from "react-test-renderer";

import {
  ALIBABA_CREDENTIAL_REF,
  BYTEDANCE_CREDENTIAL_REF,
  DEFAULT_ALIBABA_VOICE,
  DEFAULT_BYTEDANCE_VOICE,
  DEFAULT_PROVIDER,
  normalizeSettings
} from "../src/settings.js";
import { TtsSettingsCard, describeCredential, decodeSettings, saveCredential, type ClientSettingsScope } from "../src/client/settings-card.js";
import type { TtsSettings } from "../src/settings.js";

function snapshot(value: Partial<TtsSettings>, writable = true) {
  return { status: "ready" as const, value, base: undefined, user: undefined, revision: 1, writable, mode: "host" as const };
}

function controlledScope(initial: Partial<TtsSettings> = {}, writable = true, rejectFields = new Set<string>()) {
  let currentSnapshot = snapshot(initial, writable);
  const listeners = new Set<() => void>();
  const writes: Array<[string, unknown]> = [];
  const settings: ClientSettingsScope = {
    getSnapshot: () => currentSnapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    set: async (field, value) => {
      writes.push([field, value]);
      if (rejectFields.has(field)) throw new Error("rejected");
      currentSnapshot = { ...currentSnapshot, value: { ...currentSnapshot.value, [field]: value } };
      listeners.forEach((listener) => listener());
    },
    unset: async (field) => {
      writes.push([field, undefined]);
      const value = { ...currentSnapshot.value };
      delete value[field as keyof typeof value];
      currentSnapshot = { ...currentSnapshot, value };
      listeners.forEach((listener) => listener());
    }
  };
  return { settings, writes, update(value: Partial<TtsSettings>) { currentSnapshot = { ...currentSnapshot, value }; listeners.forEach((listener) => listener()); } };
}

function apiFor(statuses: Partial<Record<string, { configured: boolean; writable: boolean }>> = {}, writes: unknown[] = [], reject = false) {
  return {
    credentials: {
      describe: async (payload: { refs: string[] }) => ({ result: { ok: true, value: { credentials: Object.fromEntries(payload.refs.map((ref) => [ref, statuses[ref] ?? { configured: false, writable: true }])) } } }),
      set: async (payload: unknown) => { writes.push(["set", payload]); if (reject) throw new Error("rejected"); return { result: { ok: true, value: {} } }; }
    }
  };
}

describe("dual-provider native settings card", () => {
  it("normalizes fresh/invalid settings and starts as a compact collapsed disclosure", () => {
    expect(normalizeSettings(undefined)).toEqual({ provider: DEFAULT_PROVIDER, alibabaVoice: DEFAULT_ALIBABA_VOICE, bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    expect(decodeSettings({ provider: "bytedance", alibabaVoice: "  custom  ", bytedanceVoice: "  voice  " })).toEqual({ provider: "bytedance", alibabaVoice: "custom", bytedanceVoice: "voice" });
    expect(decodeSettings({ provider: "nope", alibabaVoice: "", bytedanceVoice: "x".repeat(129) })).toEqual({ provider: DEFAULT_PROVIDER, alibabaVoice: DEFAULT_ALIBABA_VOICE, bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    const html = renderToStaticMarkup(createElement(TtsSettingsCard, { scope: controlledScope().settings, api: apiFor() }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Tagged speech");
    expect(html).not.toContain("<dl");
  });

  it("describes and saves each credential without exposing a secret", async () => {
    const calls: unknown[] = [];
    const writes: unknown[] = [];
    const api = {
      credentials: {
        describe: async (payload: unknown) => { calls.push(payload); return { result: { ok: true, value: { credentials: { [ALIBABA_CREDENTIAL_REF]: { configured: true, source: "file", writable: true } } } } }; },
        set: async (payload: unknown) => { writes.push(payload); return { result: { ok: true, value: {} } }; }
      }
    };
    await expect(describeCredential(api)).resolves.toEqual({ configured: true, source: "file", writable: true });
    expect(calls).toEqual([{ refs: [ALIBABA_CREDENTIAL_REF] }]);
    await expect(describeCredential(api, BYTEDANCE_CREDENTIAL_REF)).resolves.toEqual({ configured: false, writable: false });
    await saveCredential(api, "new-secret", BYTEDANCE_CREDENTIAL_REF);
    expect(writes).toEqual([{ ref: BYTEDANCE_CREDENTIAL_REF, value: "new-secret" }]);
  });

  it("shows provider and free-form selected voice/key fields with independent drafts", async () => {
    const controlled = controlledScope({ provider: "alibaba", alibabaVoice: "Maia", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    const credentialWrites: unknown[] = [];
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(TtsSettingsCard, { scope: controlled.settings, api: apiFor({}, credentialWrites) })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    expect(root!.root.findByType("select").props.value).toBe("alibaba");
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.type).toBe("text");
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "bytedance" } }); });
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.value).toBe(DEFAULT_BYTEDANCE_VOICE);
    await act(async () => { root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.onChange({ target: { value: "  custom-byte  " } }); });
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "alibaba" } }); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toBe("Maia");
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "bytedance" } }); });
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.value).toBe("  custom-byte  ");
    expect(credentialWrites).toEqual([]);
    root!.unmount();
  });

  it("keeps invalid drafts visible, associates validation, and disables Save", async () => {
    const controlled = controlledScope({ alibabaVoice: "Maia" });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(TtsSettingsCard, { scope: controlled.settings, api: apiFor() })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    const input = root!.root.findByProps({ "data-settings-field": "alibaba-voice" });
    await act(async () => { input.props.onChange({ target: { value: "   " } }); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toBe("   ");
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props["aria-invalid"]).toBe(true);
    expect(root!.root.findAllByType("button").find((button) => button.props.children === "Save")!.props.disabled).toBe(true);
    await act(async () => { input.props.onChange({ target: { value: "x".repeat(129) } }); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toHaveLength(129);
    root!.unmount();
  });

  it("writes credentials, voices, then provider and retains all drafts after rejection", async () => {
    const controlled = controlledScope({ provider: "alibaba", alibabaVoice: "Maia", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE }, true, new Set(["provider"]));
    const credentialWrites: unknown[] = [];
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(TtsSettingsCard, { scope: controlled.settings, api: apiFor({}, credentialWrites) })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    await act(async () => { root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.onChange({ target: { value: "custom-alibaba" } }); });
    await act(async () => { root!.root.findByProps({ "data-settings-field": "alibaba-credential" }).props.onChange({ target: { value: "secret" } }); });
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "bytedance" } }); });
    const save = root!.root.findAllByType("button").find((button) => button.props.children === "Save")!;
    await act(async () => { await save.props.onClick(); });
    expect(credentialWrites[0]).toEqual(["set", { ref: ALIBABA_CREDENTIAL_REF, value: "secret" }]);
    expect(controlled.writes).toEqual([["alibabaVoice", "custom-alibaba"], ["provider", "bytedance"]]);
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.value).toBe(DEFAULT_BYTEDANCE_VOICE);
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-credential" }).props.value).toBe("");
    expect(root!.root.findByProps({ role: "status" }).children.join(" ")).toContain("did not accept");
    root!.unmount();
  });

  it("follows clean host updates, preserves dirty drafts, and Discard restores the latest baseline", async () => {
    const controlled = controlledScope({ provider: "alibaba", alibabaVoice: "Maia", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(TtsSettingsCard, { scope: controlled.settings, api: apiFor() })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    await act(async () => { root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.onChange({ target: { value: "draft" } }); });
    controlled.update({ provider: "bytedance", alibabaVoice: "host-new", bytedanceVoice: "host-byte" });
    await act(async () => { await Promise.resolve(); });
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.value).toBe("host-byte");
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "alibaba" } }); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toBe("draft");
    const discard = root!.root.findAllByType("button").find((button) => button.props.children === "Discard")!;
    await act(async () => { discard.props.onClick(); });
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "alibaba" } }); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toBe("host-new");
    root!.unmount();
  });

  it("is read-only remotely", async () => {
    const controlled = controlledScope({ provider: "bytedance", bytedanceVoice: "voice" });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(TtsSettingsCard, { scope: controlled.settings, api: apiFor(), localOnly: false })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    expect(root!.root.findByProps({ role: "status" }).children.join(" ")).toContain("read-only");
    expect(root!.root.findByType("select").props.disabled).toBe(true);
    expect(root!.root.findByProps({ type: "password" }).props.disabled).toBe(true);
    root!.unmount();
  });
});
