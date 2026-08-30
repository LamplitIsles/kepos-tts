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
  normalizeSettings,
  type QwenTtsSettings
} from "./constants.js";
import { TtsAssistantNodeView, type VoiceSource } from "./client/assistant-node.js";
import { TtsSettingsCard, decodeSettings, type ClientSettingsScope, type CredentialApi } from "./client/settings-card.js";
import type { TtsRpcClient } from "./player.js";

export const inject = ["connection", "locale", "settingsScope", "slots"] as const;

export type TtsLocaleKey =
  | "title" | "description" | "voice" | "voiceHint" | "apiKey" | "apiKeyHint"
  | "configured" | "notConfigured" | "expand" | "collapse" | "unsaved" | "save"
  | "saving" | "discard" | "saveFailed" | "readOnly" | "message.reasoning"
  | "message.unknownBlock" | "message.stopped" | "message.preparingAudio" | "message.audio"
  | "message.audioUnavailable" | "json.truncated" | "row.running";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "kepos-tts": TtsLocaleKey;
  }
}

const en: Record<TtsLocaleKey, string> = {
  title: "Qwen voice",
  description: "Choose the voice used to prepare tagged assistant passages.",
  voice: "Voice",
  voiceHint: "New passages use this voice after you save.",
  apiKey: "DashScope API key",
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
  title: "Qwen 语音",
  description: "选择用于预取助手标记片段的声音。",
  voice: "声音",
  voiceHint: "保存后，新片段将使用此声音。",
  apiKey: "DashScope API 密钥",
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

export function createVoiceSource(scope: Pick<SettingsScope<Partial<QwenTtsSettings>>, "getSnapshot" | "subscribe">): VoiceSource & { dispose(): void } {
  let current = normalizeSettings(scope.getSnapshot().value).voice;
  const listeners = new Set<() => void>();
  const unsubscribe = scope.subscribe(() => {
    const next = normalizeSettings(scope.getSnapshot().value).voice;
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

  const scope = ctx.settingsScope.bind<Partial<QwenTtsSettings>>({
    namespace: SETTINGS_NAMESPACE,
    decode: decodeSettings
  }) as ClientSettingsScope;
  const clientContext = ctx as unknown as ClientContext & { connection: ConnectionHandle & { api: CredentialApi } };
  const connection = clientContext.connection;
  const voiceSource = createVoiceSource(scope);
  ctx.effect(() => () => voiceSource.dispose(), "kepos-tts: voice settings observer");
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
      voiceSource
    } as never)) as never
  ));
}

export { TtsAudioPlayer, TtsPlayer } from "./player.js";
export { TtsSettingsCard, decodeSettings, describeCredential, saveCredential } from "./client/settings-card.js";
export { TtsAssistantNodeView, renderAssistantBlocks } from "./client/assistant-node.js";

export default { inject, apply };
