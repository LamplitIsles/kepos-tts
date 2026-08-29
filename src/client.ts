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
import styleText from "./client/tts.module.css";

export const inject = ["connection", "locale", "settingsScope", "slots"] as const;

export type TtsLocaleKey =
  | "title" | "description" | "voice" | "apiKey" | "configured" | "source" | "writable"
  | "unavailable" | "save" | "remove" | "saved" | "failed" | "message.reasoning"
  | "message.unknownBlock" | "message.stopped" | "json.truncated" | "row.running";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "kepos-tts": TtsLocaleKey;
  }
}

const en: Record<TtsLocaleKey, string> = {
  title: "Qwen voice",
  description: "Choose the voice used when you manually play a tagged assistant passage.",
  voice: "Voice",
  apiKey: "DashScope API key",
  configured: "Configured",
  source: "Source",
  writable: "Writable",
  unavailable: "Unavailable",
  save: "Save key",
  remove: "Remove key",
  saved: "Saved",
  failed: "Could not save this change",
  "message.reasoning": "Reasoning",
  "message.unknownBlock": "Unknown message block",
  "message.stopped": "Stopped",
  "json.truncated": "Showing {total} items",
  "row.running": "Running"
};

const zh: Record<TtsLocaleKey, string> = {
  title: "Qwen 语音",
  description: "选择手动播放助手标记片段时使用的声音。",
  voice: "声音",
  apiKey: "DashScope API 密钥",
  configured: "已配置",
  source: "来源",
  writable: "可写",
  unavailable: "不可用",
  save: "保存密钥",
  remove: "移除密钥",
  saved: "已保存",
  failed: "无法保存此更改",
  "message.reasoning": "推理",
  "message.unknownBlock": "未知消息块",
  "message.stopped": "已停止",
  "json.truncated": "显示 {total} 项",
  "row.running": "运行中"
};

function installStyles(): () => void {
  if (typeof document === "undefined") return () => undefined;
  const existing = document.querySelector('style[data-dsh-plugin="kepos-tts"]');
  if (existing) return () => undefined;
  const style = document.createElement("style");
  style.dataset.dshPlugin = "kepos-tts";
  style.textContent = styleText;
  document.head.append(style);
  return () => style.remove();
}

export function createTtsRpcClient(connection: Pick<ConnectionHandle, "rpc">): TtsRpcClient {
  return {
    async synthesize(text: string, signal?: AbortSignal): Promise<BrowserAudioPayload> {
      const result = await connection.rpc.call(RPC_CHANNEL, RPC_ENDPOINT, { text }, signal);
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
  ctx.effect(() => installStyles(), "kepos-tts: styles");
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

export { TtsAudioPill, TtsPlayer } from "./player.js";
export { TtsSettingsCard, decodeSettings, describeCredential, saveCredential, removeCredential } from "./client/settings-card.js";
export { TtsAssistantNodeView, renderAssistantBlocks } from "./client/assistant-node.js";

export default { inject, apply };
