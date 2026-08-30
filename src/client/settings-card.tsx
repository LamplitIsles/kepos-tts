import { createElement, useEffect, useId, useState } from "react";
import type { SettingsScope } from "@deepseek-ai/dsh-client-runtime/client";
import { IconChevronDownOutline14 } from "@deepseek-ai/dsh-client-ui-primitives";

import {
  CREDENTIAL_REF,
  DEFAULT_VOICE,
  SETTINGS_NAMESPACE,
  VOICE_IDS,
  VOICE_LABELS,
  normalizeSettings,
  type QwenTtsSettings,
  type VoiceId
} from "../constants.js";
import styles from "./tts.module.dshcss";

export type ClientSettingsScope = SettingsScope<Partial<QwenTtsSettings>>;

export interface CredentialStatus {
  configured: boolean;
  source?: string;
  writable: boolean;
}

export interface CredentialApi {
  credentials: {
    describe(payload: { refs: string[] }, signal?: AbortSignal): Promise<unknown>;
    set(payload: { ref: string; value: string }, signal?: AbortSignal): Promise<unknown>;
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
  }>;
}

const DEFAULT_STATUS: CredentialStatus = { configured: false, writable: false };

function responseResult(response: unknown): unknown {
  if (typeof response === "object" && response !== null && "result" in response) {
    return (response as { result?: unknown }).result;
  }
  return response;
}

function resultValue(response: unknown): unknown {
  const result = responseResult(response);
  if (typeof result === "object" && result !== null && "ok" in result) {
    const rpc = result as { ok?: unknown; value?: unknown };
    return rpc.ok === true ? rpc.value : undefined;
  }
  return result;
}

export async function describeCredential(api: CredentialApi): Promise<CredentialStatus> {
  try {
    const value = resultValue(await api.credentials.describe({ refs: [CREDENTIAL_REF] }));
    const candidate = typeof value === "object" && value !== null && "credentials" in value
      ? (value as { credentials?: Record<string, unknown> }).credentials?.[CREDENTIAL_REF]
      : value;
    if (typeof candidate !== "object" || candidate === null) return DEFAULT_STATUS;
    const info = candidate as { configured?: unknown; source?: unknown; writable?: unknown };
    return {
      configured: info.configured === true,
      ...(typeof info.source === "string" && info.source ? { source: info.source } : {}),
      writable: info.writable === true
    };
  } catch {
    return DEFAULT_STATUS;
  }
}

export async function saveCredential(api: CredentialApi, value: string): Promise<void> {
  const response = await api.credentials.set({ ref: CREDENTIAL_REF, value });
  const result = responseResult(response);
  if (typeof result === "object" && result !== null && "ok" in result && (result as { ok?: unknown }).ok !== true) {
    throw new Error("credential-rejected");
  }
}

export function decodeSettings(value: unknown): Partial<QwenTtsSettings> {
  return { voice: normalizeSettings(value).voice };
}

/**
 * A small feature-owned equivalent of DSH's PluginCard. The structure mirrors
 * the native card: collapsed disclosure header, staged field rows, and one
 * Save/Discard footer. Secrets are write-only and never read back.
 */
export function TtsSettingsCard({ scope, api, localOnly = true, t, labels }: TtsSettingsCardProps) {
  const snapshot = scope.getSnapshot();
  const [current, setCurrent] = useState(snapshot);
  const [credential, setCredential] = useState<CredentialStatus>(DEFAULT_STATUS);
  const [draftVoice, setDraftVoice] = useState<VoiceId | undefined>();
  const [draftKey, setDraftKey] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const cardId = useId();

  useEffect(() => scope.subscribe(() => setCurrent(scope.getSnapshot())), [scope]);
  useEffect(() => {
    let active = true;
    void describeCredential(api).then((status) => {
      if (active) setCredential(status);
    });
    return () => {
      active = false;
    };
  }, [api]);

  const voice = normalizeSettings(current.value).voice;
  const selectedVoice = draftVoice ?? voice;
  const canWriteSettings = localOnly && current.writable;
  const canWriteCredential = localOnly && credential.writable;
  const voiceDirty = draftVoice !== undefined && draftVoice !== voice;
  const keyDirty = draftKey.trim() !== "";
  const dirty = voiceDirty || keyDirty;

  const text = {
    title: t?.("title") ?? "Qwen voice",
    description: t?.("description") ?? "Choose the voice used to prepare tagged assistant passages.",
    voice: t?.("voice") ?? "Voice",
    voiceHint: t?.("voiceHint") ?? "New passages use this voice after you save.",
    apiKey: t?.("apiKey") ?? "DashScope API key",
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
    ...labels
  };

  // DSH's PluginCard is absent when its namespace is unavailable.
  if (current.status !== "ready") return null;

  const editVoice = (event: { target: { value: string } }) => {
    if (!canWriteSettings || saving) return;
    const next = (VOICE_IDS as readonly string[]).includes(event.target.value)
      ? event.target.value as VoiceId
      : DEFAULT_VOICE;
    setDraftVoice(next === voice ? undefined : next);
    setFailed(false);
  };

  const discard = () => {
    if (saving) return;
    setDraftVoice(undefined);
    setDraftKey("");
    setFailed(false);
  };

  const save = async () => {
    if (!dirty || saving || !canWriteSettings && voiceDirty || !canWriteCredential && keyDirty) return;
    setSaving(true);
    setFailed(false);
    let landed = true;
    try {
      if (voiceDirty && draftVoice !== undefined) await scope.set("voice", draftVoice);
      if (keyDirty && canWriteCredential) {
        await saveCredential(api, draftKey.trim());
        setCredential(await describeCredential(api));
      }
    } catch {
      landed = false;
    }
    setSaving(false);
    if (landed) {
      setDraftVoice(undefined);
      setDraftKey("");
    }
    setFailed(!landed);
  };

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
            createElement("label", { className: styles.settingsFieldLabel, htmlFor: `${cardId}-voice` }, text.voice)
          ),
          createElement(
            "select",
            {
              id: `${cardId}-voice`,
              className: styles.settingsSelect,
              value: selectedVoice,
              onChange: editVoice,
              disabled: saving || !canWriteSettings,
              "aria-describedby": `${cardId}-voice-hint`
            },
            VOICE_IDS.map((id) => createElement("option", { key: id, value: id }, VOICE_LABELS[id]))
          ),
          createElement("p", { className: styles.settingsHint, id: `${cardId}-voice-hint` }, text.voiceHint)
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
              { className: credential.configured ? styles.settingsBadge : styles.settingsBadgeMuted, "data-configured": credential.configured ? "yes" : "no" },
              credential.configured ? text.configured : text.notConfigured
            )
          ),
          createElement("input", {
            id: `${cardId}-key`,
            className: styles.settingsInput,
            type: "password",
            autoComplete: "off",
            value: draftKey,
            disabled: saving || !canWriteCredential,
            onChange: (event: { target: { value: string } }) => {
              setDraftKey(event.target.value);
              setFailed(false);
            },
            "aria-describedby": `${cardId}-key-hint`
          }),
          createElement("p", { className: styles.settingsHint, id: `${cardId}-key-hint` }, text.apiKeyHint)
        ),
        createElement(
          "div",
          { className: styles.settingsFooter },
          failed ? createElement("p", { className: styles.settingsFailed, role: "status" }, text.saveFailed) : null,
          createElement("button", { type: "button", className: styles.settingsDiscard, disabled: !dirty || saving, onClick: discard }, text.discard),
          createElement("button", { type: "button", className: styles.settingsSave, disabled: !dirty || saving, onClick: () => void save() }, saving ? text.saving : text.save)
        )
      )
      : null
  );
}
