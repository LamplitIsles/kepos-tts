import { createElement } from "react";
import type { ClientContext, SettingsScope } from "@deepseek-ai/dsh-client-runtime/client";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";

import { RPC_CHANNEL, RPC_ENDPOINT, type BrowserAudioPayload } from "./rpc.js";
import {
  SETTINGS_NAMESPACE,
  providerProfileKey,
  type TtsSettings
} from "./constants.js";
import { TtsAssistantNodeView, type ProfileSource } from "./client/assistant-node.js";
import { TtsSettingsCard, decodeSettings, type ClientSettingsScope, type CredentialApi } from "./client/settings-card.js";
import type { TtsRpcClient } from "./player.js";

export const inject = ["connection", "locale", "settingsScope", "slots"] as const;

export type TtsLocaleKey =
  | "title" | "description" | "provider" | "providerHint" | "voice" | "voiceHint" | "apiKey" | "apiKeyHint"
  | "configured" | "notConfigured" | "expand" | "collapse" | "unsaved" | "save"
  | "saving" | "discard" | "saveFailed" | "readOnly" | "voiceRequired" | "voiceTooLong" | "message.reasoning"
  | "message.unknownBlock" | "message.stopped" | "message.preparingAudio" | "message.audio"
  | "message.audioUnavailable" | "json.truncated" | "row.running";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "kepos-tts": TtsLocaleKey;
  }
}

const en: Record<TtsLocaleKey, string> = {
  title: "Text-to-Speech",
  description: "Choose the provider and voice used to synthesize tagged assistant passages.",
  provider: "Provider",
  providerHint: "New passages use this provider after you save.",
  voice: "Voice ID",
  voiceHint: "Enter a provider-supported Voice ID (up to 128 characters).",
  apiKey: "API key",
  apiKeyHint: "Enter a new key to replace the configured key. Leave blank to keep it.",
  configured: "Configured",
  notConfigured: "Not configured",
  expand: "Expand",
  collapse: "Collapse",
  unsaved: "Unsaved",
  save: "Save",
  saving: "Saving…",
  discard: "Discard",
  saveFailed: "The deployment did not accept these values; they were left for you to correct.",
  readOnly: "This deployment is read-only.",
  voiceRequired: "Voice ID is required.",
  voiceTooLong: "Voice ID must be 128 characters or fewer.",
  "message.reasoning": "Reasoning",
  "message.unknownBlock": "Unknown message block",
  "message.stopped": "Stopped",
  "message.preparingAudio": "Preparing audio…",
  "message.audio": "Audio message",
  "message.audioUnavailable": "Audio unavailable; transcript shown.",
  "json.truncated": "Showing {total} items",
  "row.running": "Running"
};

const zh: Record<TtsLocaleKey, string> = {
  title: "语音合成",
  description: "选择语音合成使用的服务商和声音。",
  provider: "服务商",
  providerHint: "保存后，新片段将使用此服务商。",
  voice: "声音 ID",
  voiceHint: "输入服务商支持的声音 ID（最多 128 个字符）。",
  apiKey: "API 密钥",
  apiKeyHint: "输入新密钥以替换现有密钥。留空则保留现有密钥。",
  configured: "已配置",
  notConfigured: "未配置",
  expand: "展开",
  collapse: "收起",
  unsaved: "未保存",
  save: "保存",
  saving: "保存中…",
  discard: "放弃",
  saveFailed: "本部署未接受这些值；已保留供你修改。",
  readOnly: "此部署为只读。",
  voiceRequired: "声音 ID 不能为空。",
  voiceTooLong: "声音 ID 不能超过 128 个字符。",
  "message.reasoning": "推理",
  "message.unknownBlock": "未知消息块",
  "message.stopped": "已停止",
  "message.preparingAudio": "正在准备音频…",
  "message.audio": "语音消息",
  "message.audioUnavailable": "音频不可用；已显示文字。",
  "json.truncated": "显示 {total} 项",
  "row.running": "运行中"
};

export function createTtsRpcClient(connection: Pick<ConnectionHandle, "rpc">): TtsRpcClient {
  return {
    async synthesize(text: string, sessionId: string, signal?: AbortSignal): Promise<BrowserAudioPayload> {
      const result = await connection.rpc.call(RPC_CHANNEL, RPC_ENDPOINT, { text, sessionId }, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value as BrowserAudioPayload;
    }
  };
}

export function createProfileSource(scope: Pick<SettingsScope<Partial<TtsSettings>>, "getSnapshot" | "subscribe">): ProfileSource & { dispose(): void } {
  const profileFromSnapshot = () => {
    const snapshot = scope.getSnapshot();
    return snapshot.status === "ready" && snapshot.mode === "host" && snapshot.value !== undefined
      ? providerProfileKey(snapshot.value)
      : undefined;
  };
  let current = profileFromSnapshot();
  const listeners = new Set<() => void>();
  const unsubscribe = scope.subscribe(() => {
    const next = profileFromSnapshot();
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
  });
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      unsubscribe();
      listeners.clear();
    }
  };
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(SETTINGS_NAMESPACE, { en, zh }), "kepos-tts: dictionaries");

  const scope = ctx.settingsScope.bind<Partial<TtsSettings>>({
    namespace: SETTINGS_NAMESPACE,
    decode: decodeSettings
  }) as ClientSettingsScope;
  const clientContext = ctx as unknown as ClientContext & { connection: ConnectionHandle & { api: CredentialApi } };
  const connection = clientContext.connection;
  const profileSource = createProfileSource(scope);
  ctx.effect(() => () => profileSource.dispose(), "kepos-tts: profile settings observer");
  const client = createTtsRpcClient(connection);

  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register(
    {
      name: "settings.plugin.item",
      key: SETTINGS_NAMESPACE,
      priority: 0,
      inject: () => ({}),
      locale: SETTINGS_NAMESPACE
    } as never,
    ((props: Record<string, unknown>) => createElement(TtsSettingsCard, {
      ...props,
      scope,
      api: connection.api,
      localOnly: connection.isLoopback
    } as never)) as never
  ));

  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register(
    {
      name: "conversation.chat.node",
      key: "assistant-step",
      priority: -1,
      locale: SETTINGS_NAMESPACE
    } as never,
    ((props: Record<string, unknown>) => createElement(TtsAssistantNodeView, {
      ...props,
      client,
      profileSource
    } as never)) as never
  ));
}

export { TtsAudioPlayer, TtsPlayer } from "./player.js";
export { TtsSettingsCard, decodeSettings, describeCredential, saveCredential } from "./client/settings-card.js";
export { TtsAssistantNodeView, renderAssistantBlocks, type ProfileSource } from "./client/assistant-node.js";

export default { inject, apply };
