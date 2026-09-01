import { createElement, useEffect, useId, useRef, useState } from "react";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import { IconChevronDownOutline14 } from "@deepseek-ai/dsh-client-ui-primitives";

import {
  ALIBABA_CREDENTIAL_REF,
  BYTEDANCE_CREDENTIAL_REF,
  DEFAULT_ALIBABA_VOICE,
  DEFAULT_BYTEDANCE_VOICE,
  SETTINGS_NAMESPACE,
  TTS_PROVIDERS,
  VOICE_ID_MAX_LENGTH,
  normalizeProvider,
  normalizeSettings,
  normalizeVoiceId,
  type TtsProvider,
  type TtsSettings
} from "../constants.js";
import styles from "./tts.module.dshcss";

export type ClientSettingsScope = SettingsScope<Partial<TtsSettings>>;

export interface CredentialStatus {
  configured: boolean;
  source?: string;
  writable: boolean;
}

export interface CredentialApi {
  credentials: {
    describe(refs: string[]): Promise<unknown>;
    set(ref: string, value: string): Promise<unknown>;
  };
}

export interface TtsSettingsCardProps {
  scope: ClientSettingsScope;
  api: CredentialApi;
  /** DSH Settings/credential writes are only permitted from loopback Web. */
  localOnly?: boolean;
  t?: (key: string, params?: Record<string, unknown>) => string;
  labels?: Partial<{
    title: string;
    description: string;
    provider: string;
    providerHint: string;
    voice: string;
    voiceHint: string;
    apiKey: string;
    apiKeyHint: string;
    configured: string;
    notConfigured: string;
    expand: string;
    collapse: string;
    unsaved: string;
    save: string;
    saving: string;
    discard: string;
    saveFailed: string;
    readOnly: string;
    voiceRequired: string;
    voiceTooLong: string;
  }>;
}

const DEFAULT_STATUS: CredentialStatus = { configured: false, writable: false };
const DEFAULT_STATUSES: Record<TtsProvider, CredentialStatus> = {
  alibaba: DEFAULT_STATUS,
  bytedance: DEFAULT_STATUS
};
const EMPTY_DRAFT_KEYS: Record<TtsProvider, string> = { alibaba: "", bytedance: "" };

interface PreservedDraftAttempt {
  provider: TtsProvider | undefined;
  voices: Partial<Record<TtsProvider, string>>;
  keys: Record<TtsProvider, string>;
}

function credentialRefFor(provider: TtsProvider): string {
  return provider === "bytedance" ? BYTEDANCE_CREDENTIAL_REF : ALIBABA_CREDENTIAL_REF;
}

function voiceFieldFor(provider: TtsProvider): "alibabaVoice" | "bytedanceVoice" {
  return provider === "bytedance" ? "bytedanceVoice" : "alibabaVoice";
}

function defaultVoiceFor(provider: TtsProvider): string {
  return provider === "bytedance" ? DEFAULT_BYTEDANCE_VOICE : DEFAULT_ALIBABA_VOICE;
}

function resultValue(response: unknown): unknown {
  if (typeof response === "object" && response !== null && "ok" in response) {
    const remote = response as { ok?: unknown; value?: unknown };
    return remote.ok === true ? remote.value : undefined;
  }
  return undefined;
}

function credentialView(value: unknown, ref: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return ref in value ? (value as Record<string, unknown>)[ref] : undefined;
}

export async function describeCredential(api: CredentialApi, ref = ALIBABA_CREDENTIAL_REF): Promise<CredentialStatus> {
  try {
    const value = credentialView(resultValue(await api.credentials.describe([ref])), ref);
    if (typeof value !== "object" || value === null) return DEFAULT_STATUS;
    const info = value as { configured?: unknown; source?: unknown; writable?: unknown };
    return {
      configured: info.configured === true,
      ...(typeof info.source === "string" && info.source ? { source: info.source } : {}),
      writable: info.writable === true
    };
  } catch {
    return DEFAULT_STATUS;
  }
}

export async function saveCredential(api: CredentialApi, value: string, ref = ALIBABA_CREDENTIAL_REF): Promise<void> {
  const response = await api.credentials.set(ref, value);
  if (typeof response === "object" && response !== null && "ok" in response && (response as { ok?: unknown }).ok !== true) {
    throw new Error("credential-rejected");
  }
}

export function decodeSettings(value: unknown): Partial<TtsSettings> {
  return normalizeSettings(value);
}

function validateVoiceDraft(value: string | undefined, fallback: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return "required";
  if (Array.from(normalized).length > VOICE_ID_MAX_LENGTH) return "too-long";
  // Calling the shared normalizer here keeps the UI and host profile rules in
  // lockstep while retaining the raw draft in the input.
  if (normalizeVoiceId(value, fallback) !== normalized) return "invalid";
  return undefined;
}

/**
 * A compact DSH-native disclosure card with durable baseline/draft semantics.
 * Secrets are write-only and never read back.
 */
export function TtsSettingsCard({ scope, api, localOnly = true, t, labels }: TtsSettingsCardProps) {
  const initialSnapshot = scope.getSnapshot();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [baseline, setBaseline] = useState<TtsSettings>(() => normalizeSettings(initialSnapshot.value));
  const [draftProvider, setDraftProvider] = useState<TtsProvider | undefined>();
  const [draftVoices, setDraftVoices] = useState<Partial<Record<TtsProvider, string>>>({});
  const [draftKeys, setDraftKeys] = useState<Record<TtsProvider, string>>(EMPTY_DRAFT_KEYS);
  const [credentials, setCredentials] = useState<Record<TtsProvider, CredentialStatus>>(DEFAULT_STATUSES);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const preservedAttemptRef = useRef<PreservedDraftAttempt | undefined>(undefined);
  const cardId = useId();

  useEffect(() => scope.subscribe(() => {
    const next = scope.getSnapshot();
    const nextBaseline = normalizeSettings(next.value);
    setSnapshot(next);
    // Always advance the saved baseline. A draft that now equals the Host
    // value is no longer dirty; clearing it here lets a later Host refresh
    // flow through instead of leaving the input stuck on stale local state.
    setBaseline(nextBaseline);
    const preservedAttempt = preservedAttemptRef.current;
    setDraftProvider((current) => {
      if (preservedAttempt?.provider !== undefined) return preservedAttempt.provider;
      return current === nextBaseline.provider ? undefined : current;
    });
    setDraftVoices((current) => {
      const nextDrafts: Partial<Record<TtsProvider, string>> = {};
      for (const provider of TTS_PROVIDERS) {
        const draft = current[provider];
        const preservedDraft = preservedAttempt?.voices[provider];
        if (preservedDraft !== undefined) {
          nextDrafts[provider] = preservedDraft;
          continue;
        }
        if (draft === undefined) continue;
        const fallback = defaultVoiceFor(provider);
        const field = voiceFieldFor(provider);
        const valid = validateVoiceDraft(draft, fallback) === undefined;
        if (!valid || normalizeVoiceId(draft, fallback) !== nextBaseline[field]) nextDrafts[provider] = draft;
      }
      return nextDrafts;
    });
  }), [scope]);

  useEffect(() => {
    if (snapshot.status !== "ready" || snapshot.mode !== "host") return;
    let active = true;
    void Promise.all(TTS_PROVIDERS.map(async (provider) => [provider, await describeCredential(api, credentialRefFor(provider))] as const))
      .then((entries) => {
        if (!active) return;
        setCredentials((current) => {
          const next = { ...current };
          for (const [provider, status] of entries) next[provider] = status;
          return next;
        });
      });
    return () => {
      active = false;
    };
  }, [api, snapshot.mode, snapshot.status]);

  const selectedProvider = draftProvider ?? baseline.provider;
  const selectedField = voiceFieldFor(selectedProvider);
  const selectedSavedVoice = baseline[selectedField];
  const selectedDraftVoice = draftVoices[selectedProvider];
  const selectedVoice = selectedDraftVoice ?? selectedSavedVoice;
  const selectedKey = draftKeys[selectedProvider] ?? "";
  const voiceError = validateVoiceDraft(selectedDraftVoice, defaultVoiceFor(selectedProvider));

  const providerDirty = draftProvider !== undefined && draftProvider !== baseline.provider;
  const voiceDirty = TTS_PROVIDERS.some((provider) => {
    const draft = draftVoices[provider];
    return draft !== undefined && normalizeVoiceId(draft, defaultVoiceFor(provider)) !== baseline[voiceFieldFor(provider)];
  });
  const keyDirty = TTS_PROVIDERS.some((provider) => (draftKeys[provider] ?? "").trim() !== "");
  const invalidVoice = TTS_PROVIDERS.some((provider) => validateVoiceDraft(draftVoices[provider], defaultVoiceFor(provider)) !== undefined);
  const dirty = providerDirty || voiceDirty || keyDirty || TTS_PROVIDERS.some((provider) => draftVoices[provider] !== undefined);
  const canWriteSettings = localOnly && snapshot.mode === "host" && snapshot.writable;
  const canWriteCredential = (provider: TtsProvider): boolean => canWriteSettings && credentials[provider]?.writable === true;
  const credentialBlocked = TTS_PROVIDERS.some((provider) => (draftKeys[provider] ?? "").trim() !== "" && !canWriteCredential(provider));
  const canSave = dirty && !saving && canWriteSettings && !credentialBlocked && !invalidVoice;

  const text = {
    title: t?.("title") ?? "Text-to-Speech",
    description: t?.("description") ?? "Choose the provider and voice used to synthesize tagged assistant passages.",
    provider: t?.("provider") ?? "Provider",
    providerHint: t?.("providerHint") ?? "New passages use this provider after you save.",
    voice: t?.("voice") ?? "Voice ID",
    voiceHint: t?.("voiceHint") ?? "Enter a provider-supported Voice ID (up to 128 characters).",
    apiKey: labels?.apiKey ?? t?.("apiKey") ?? (selectedProvider === "bytedance" ? "Volcengine API key" : "DashScope API key"),
    apiKeyHint: t?.("apiKeyHint") ?? "Enter a new key to replace the configured key. Leave blank to keep it.",
    configured: t?.("configured") ?? "Configured",
    notConfigured: t?.("notConfigured") ?? "Not configured",
    expand: t?.("expand") ?? "Expand",
    collapse: t?.("collapse") ?? "Collapse",
    unsaved: t?.("unsaved") ?? "Unsaved",
    save: t?.("save") ?? "Save",
    saving: t?.("saving") ?? "Saving…",
    discard: t?.("discard") ?? "Discard",
    saveFailed: t?.("saveFailed") ?? "The deployment did not accept these values; they were left for you to correct.",
    readOnly: t?.("readOnly") ?? "This deployment is read-only.",
    voiceRequired: t?.("voiceRequired") ?? "Voice ID is required.",
    voiceTooLong: t?.("voiceTooLong") ?? `Voice ID must be ${VOICE_ID_MAX_LENGTH} characters or fewer.`,
    ...labels
  };

  // DSH's PluginCard is absent while its namespace is unavailable/loading.
  if (snapshot.status !== "ready" || snapshot.mode !== "host") return null;

  const forgetPreservedProvider = () => {
    const preserved = preservedAttemptRef.current;
    if (preserved) preservedAttemptRef.current = { ...preserved, provider: undefined };
  };

  const forgetPreservedVoice = (provider: TtsProvider) => {
    const preserved = preservedAttemptRef.current;
    if (!preserved) return;
    const voices = { ...preserved.voices };
    delete voices[provider];
    preservedAttemptRef.current = { ...preserved, voices };
  };

  const forgetPreservedKey = (provider: TtsProvider) => {
    const preserved = preservedAttemptRef.current;
    if (!preserved) return;
    const keys = { ...preserved.keys };
    delete keys[provider];
    preservedAttemptRef.current = { ...preserved, keys };
  };

  const editProvider = (event: { target: { value: string } }) => {
    if (!canWriteSettings || saving) return;
    const next = normalizeProvider(event.target.value);
    forgetPreservedProvider();
    setDraftProvider(next === baseline.provider ? undefined : next);
    setFailed(false);
  };

  const editVoice = (event: { target: { value: string } }) => {
    if (!canWriteSettings || saving) return;
    const value = event.target.value;
    forgetPreservedVoice(selectedProvider);
    setDraftVoices((current) => ({ ...current, [selectedProvider]: value === selectedSavedVoice ? undefined : value }));
    setFailed(false);
  };

  const editKey = (event: { target: { value: string } }) => {
    if (!canWriteCredential(selectedProvider) || saving) return;
    const value = event.target.value;
    forgetPreservedKey(selectedProvider);
    setDraftKeys((current) => ({ ...current, [selectedProvider]: value }));
    setFailed(false);
  };

  const discard = () => {
    if (saving) return;
    preservedAttemptRef.current = undefined;
    setDraftProvider(undefined);
    setDraftVoices({});
    setDraftKeys({ ...EMPTY_DRAFT_KEYS });
    setFailed(false);
  };

  const save = async () => {
    if (!canSave) return;
    // Host snapshots can arrive between ordered writes. Keep a copy of the
    // complete transaction so reconciliation cannot erase a staged value if a
    // later write rejects and the user needs to retry the same Save.
    const stagedProvider = draftProvider;
    const stagedVoices = { ...draftVoices };
    const stagedKeys = { ...draftKeys };
    const stagedBaseline = baseline;
    preservedAttemptRef.current = { provider: stagedProvider, voices: stagedVoices, keys: stagedKeys };
    setSaving(true);
    setFailed(false);
    const credentialProviders: TtsProvider[] = [];
    try {
      // Credentials must land before a setting can select a profile that needs
      // one. Keep every draft until the whole ordered transaction succeeds.
      for (const provider of TTS_PROVIDERS) {
        const value = (stagedKeys[provider] ?? "").trim();
        if (!value) continue;
        await saveCredential(api, value, credentialRefFor(provider));
        credentialProviders.push(provider);
      }

      for (const provider of TTS_PROVIDERS) {
        const draft = stagedVoices[provider];
        const field = voiceFieldFor(provider);
        if (draft === undefined) continue;
        const value = normalizeVoiceId(draft, defaultVoiceFor(provider));
        if (value === stagedBaseline[field]) continue;
        await scope.set(field, value);
        if (normalizeSettings(scope.getSnapshot().value)[field] !== value) throw new Error("settings-rejected");
      }

      if (stagedProvider !== undefined && stagedProvider !== stagedBaseline.provider) {
        await scope.set("provider", stagedProvider);
        if (normalizeSettings(scope.getSnapshot().value).provider !== stagedProvider) throw new Error("settings-rejected");
      }

      await Promise.all(credentialProviders.map(async (provider) => {
        const status = await describeCredential(api, credentialRefFor(provider));
        setCredentials((current) => ({ ...current, [provider]: status }));
      }));
      // The scope has settled each accepted write. Reading it here also keeps
      // clean fields current if another Host refresh arrived while saving.
      setBaseline(normalizeSettings(scope.getSnapshot().value));
      preservedAttemptRef.current = undefined;
      setDraftProvider(undefined);
      setDraftVoices({});
      setDraftKeys({ ...EMPTY_DRAFT_KEYS });
    } catch {
      // An earlier credential may have succeeded; retaining all drafts makes a
      // retry safe and gives the user the exact values that still need landing.
      setDraftProvider(stagedProvider);
      setDraftVoices(stagedVoices);
      setDraftKeys(stagedKeys);
      await Promise.all(credentialProviders.map(async (provider) => {
        const status = await describeCredential(api, credentialRefFor(provider));
        setCredentials((current) => ({ ...current, [provider]: status }));
      }));
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const selectedCredential = credentials[selectedProvider] ?? DEFAULT_STATUS;
  const voiceErrorText = voiceError === "required"
    ? text.voiceRequired
    : voiceError === "too-long"
      ? text.voiceTooLong
      : undefined;

  return createElement(
    "li",
    { className: `${styles.settingsCard} ${open ? styles.settingsCardOpen : ""}`, "data-settings-card": SETTINGS_NAMESPACE },
    createElement(
      "button",
      {
        type: "button",
        className: styles.settingsHeader,
        "aria-expanded": open,
        "aria-controls": `${cardId}-body`,
        "aria-label": `${open ? text.collapse : text.expand}: ${text.title}`,
        onClick: () => setOpen((value) => !value)
      },
      createElement(
        "span",
        { className: styles.settingsHeadText },
        createElement("span", { className: styles.settingsName }, text.title),
        createElement("span", { className: styles.settingsDescription }, text.description)
      ),
      dirty ? createElement("span", { className: styles.settingsPending }, text.unsaved) : null,
      createElement(IconChevronDownOutline14, {
        className: `${styles.settingsChevron} ${open ? styles.settingsChevronOpen : ""}`
      })
    ),
    open
      ? createElement(
        "div",
        { className: styles.settingsBody, id: `${cardId}-body` },
        !canWriteSettings ? createElement("p", { className: styles.settingsReadOnly, role: "status" }, text.readOnly) : null,
        createElement(
          "div",
          { className: styles.settingsField },
          createElement(
            "div",
            { className: styles.settingsFieldHead },
            createElement("label", { className: styles.settingsFieldLabel, htmlFor: `${cardId}-provider` }, text.provider)
          ),
          createElement(
            "select",
            {
              id: `${cardId}-provider`,
              className: styles.settingsSelect,
              value: selectedProvider,
              onChange: editProvider,
              disabled: saving || !canWriteSettings,
              "aria-describedby": `${cardId}-provider-hint`,
              "data-settings-field": "provider"
            },
            createElement("option", { value: "alibaba" }, "Alibaba"),
            createElement("option", { value: "bytedance" }, "ByteDance")
          ),
          createElement("p", { className: styles.settingsHint, id: `${cardId}-provider-hint` }, text.providerHint)
        ),
        createElement(
          "div",
          { className: styles.settingsField },
          createElement(
            "div",
            { className: styles.settingsFieldHead },
            createElement("label", { className: styles.settingsFieldLabel, htmlFor: `${cardId}-voice` }, text.voice)
          ),
          createElement("input", {
            id: `${cardId}-voice`,
            className: [styles.settingsInput, voiceErrorText ? styles.settingsInputInvalid : undefined].filter(Boolean).join(" "),
            type: "text",
            autoComplete: "off",
            value: selectedVoice,
            disabled: saving || !canWriteSettings,
            onChange: editVoice,
            "aria-invalid": voiceErrorText !== undefined ? true : undefined,
            "aria-describedby": `${cardId}-voice-hint`,
            "data-settings-field": `${selectedProvider}-voice`
          }),
          createElement("p", { className: [styles.settingsHint, voiceErrorText ? styles.settingsInvalid : undefined].filter(Boolean).join(" "), id: `${cardId}-voice-hint` }, voiceErrorText ?? text.voiceHint)
        ),
        createElement(
          "div",
          { className: styles.settingsField },
          createElement(
            "div",
            { className: styles.settingsFieldHead },
            createElement("label", { className: styles.settingsFieldLabel, htmlFor: `${cardId}-key` }, text.apiKey),
            createElement(
              "span",
              { className: selectedCredential.configured ? styles.settingsBadge : styles.settingsBadgeMuted, "data-configured": selectedCredential.configured ? "yes" : "no" },
              selectedCredential.configured ? text.configured : text.notConfigured
            )
          ),
          createElement("input", {
            id: `${cardId}-key`,
            className: styles.settingsInput,
            type: "password",
            autoComplete: "new-password",
            value: selectedKey,
            disabled: saving || !canWriteCredential(selectedProvider),
            onChange: editKey,
            "aria-describedby": `${cardId}-key-hint`,
            "data-settings-field": `${selectedProvider}-credential`
          }),
          createElement("p", { className: styles.settingsHint, id: `${cardId}-key-hint` }, text.apiKeyHint)
        ),
        createElement(
          "div",
          { className: styles.settingsFooter },
          failed ? createElement("p", { className: styles.settingsFailed, role: "status" }, text.saveFailed) : null,
          createElement("button", { type: "button", className: styles.settingsDiscard, disabled: !dirty || saving, onClick: discard }, text.discard),
          createElement("button", { type: "button", className: styles.settingsSave, disabled: !canSave, onClick: () => void save() }, saving ? text.saving : text.save)
        )
      )
      : null
  );
}
