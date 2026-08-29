import { createElement, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { SettingsScope } from "@deepseek-ai/dsh-client-runtime/client";

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
    unset(payload: { ref: string }, signal?: AbortSignal): Promise<unknown>;
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
    apiKey: string;
    configured: string;
    source: string;
    writable: string;
    unavailable: string;
    save: string;
    remove: string;
    saved: string;
    failed: string;
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

export async function removeCredential(api: CredentialApi): Promise<void> {
  const response = await api.credentials.unset({ ref: CREDENTIAL_REF });
  const result = responseResult(response);
  if (typeof result === "object" && result !== null && "ok" in result && (result as { ok?: unknown }).ok !== true) {
    throw new Error("credential-rejected");
  }
}

export function decodeSettings(value: unknown): Partial<QwenTtsSettings> {
  return { voice: normalizeSettings(value).voice };
}

export function TtsSettingsCard({ scope, api, localOnly = true, t, labels }: TtsSettingsCardProps) {
  const [snapshot, setSnapshot] = useState(scope.getSnapshot());
  const [credential, setCredential] = useState<CredentialStatus>(DEFAULT_STATUS);
  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed">();
  const voice = normalizeSettings(snapshot.value).voice;
  const canWriteSettings = localOnly && snapshot.writable;
  const canWrite = localOnly && credential.writable;

  useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
  useEffect(() => {
    let active = true;
    void describeCredential(api).then((status) => {
      if (active) setCredential(status);
    });
    return () => {
      active = false;
    };
  }, [api]);

  const selectVoice = async (event: { target: { value: string } }) => {
    if (!canWriteSettings) return;
    const next = (VOICE_IDS as readonly string[]).includes(event.target.value)
      ? event.target.value as VoiceId
      : DEFAULT_VOICE;
    setBusy(true);
    setFeedback(undefined);
    try {
      await scope.set("voice", next);
      setFeedback("saved");
    } catch {
      setFeedback("failed");
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draftKey.trim() || !canWrite) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      await saveCredential(api, draftKey.trim());
      setDraftKey("");
      setCredential(await describeCredential(api));
      setFeedback("saved");
    } catch {
      setFeedback("failed");
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    if (!credential.configured || !canWrite) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      await removeCredential(api);
      setCredential(await describeCredential(api));
      setFeedback("saved");
    } catch {
      setFeedback("failed");
    } finally {
      setBusy(false);
    }
  };

  const text = {
    title: t?.("title") ?? "Qwen voice",
    description: t?.("description") ?? "Choose the voice used when you manually play a tagged assistant passage.",
    voice: t?.("voice") ?? "Voice",
    apiKey: t?.("apiKey") ?? "DashScope API key",
    configured: t?.("configured") ?? "Configured",
    source: t?.("source") ?? "Source",
    writable: t?.("writable") ?? "Writable",
    unavailable: t?.("unavailable") ?? "Unavailable",
    save: t?.("save") ?? "Save key",
    remove: t?.("remove") ?? "Remove key",
    saved: t?.("saved") ?? "Saved",
    failed: t?.("failed") ?? "Could not save this change",
    ...labels
  };
  const credentialState = credential.configured ? "yes" : "no";

  return createElement(
    "section",
    { className: "kepos-tts-settings-card", "aria-labelledby": `${SETTINGS_NAMESPACE}-title` },
    createElement("p", { className: "kepos-tts-eyebrow" }, "MANUAL SPEECH"),
    createElement("h2", { className: "kepos-tts-title", id: `${SETTINGS_NAMESPACE}-title` }, text.title),
    createElement("p", { className: "kepos-tts-description" }, text.description),
    createElement(
      "label",
      { className: "kepos-tts-label", htmlFor: `${SETTINGS_NAMESPACE}-voice` },
      text.voice,
      createElement(
        "select",
        { id: `${SETTINGS_NAMESPACE}-voice`, className: "kepos-tts-select", value: voice, onChange: selectVoice, disabled: busy || snapshot.status === "unavailable" || !canWriteSettings },
        VOICE_IDS.map((id) => createElement("option", { key: id, value: id }, VOICE_LABELS[id]))
      )
    ),
    createElement(
      "dl",
      { className: "kepos-tts-credential-status", "aria-label": text.apiKey },
      createElement("dt", null, text.configured),
      createElement("dd", { "data-configured": credentialState }, credential.configured ? "yes" : "no"),
      createElement("dt", null, text.source),
      createElement("dd", null, credential.source ?? "—"),
      createElement("dt", null, text.writable),
      createElement("dd", { "data-writable": canWrite ? "yes" : "no" }, canWrite ? "yes" : "no")
    ),
    canWrite
      ? createElement(
        "form",
        { className: "kepos-tts-key-form", onSubmit: saveKey },
        createElement("label", { className: "kepos-tts-label", htmlFor: `${SETTINGS_NAMESPACE}-key` }, text.apiKey),
        createElement("input", {
          id: `${SETTINGS_NAMESPACE}-key`,
          className: "kepos-tts-key-input",
          type: "password",
          value: draftKey,
          onChange: (event: { target: { value: string } }) => setDraftKey(event.target.value),
          autoComplete: "new-password",
          placeholder: "Enter a new key",
          disabled: busy,
          "aria-label": text.apiKey
        }),
        createElement("button", { className: "kepos-tts-action", type: "submit", disabled: busy || !draftKey.trim() }, text.save),
        credential.configured
          ? createElement("button", { className: "kepos-tts-action kepos-tts-action-secondary", type: "button", onClick: removeKey, disabled: busy }, text.remove)
          : null
      )
      : createElement("p", { className: "kepos-tts-unavailable", role: "status" }, text.unavailable),
    feedback === "saved" ? createElement("p", { className: "kepos-tts-feedback", role: "status" }, text.saved) : null,
    feedback === "failed" ? createElement("p", { className: "kepos-tts-feedback", role: "alert" }, text.failed) : null
  );
}
