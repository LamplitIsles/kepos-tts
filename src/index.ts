import type { Context } from "@deepseek-ai/cordis";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

import {
  DEFAULT_VOICE,
  QwenTtsSettingsSchema,
  SETTINGS_NAMESPACE,
  normalizeSettings
} from "./settings.js";
import { QwenTtsGateway, registerTtsRpc } from "./gateway.js";
import { registerTtsPrompt } from "./prompt.js";

export const name = "kepos-tts";
export const inject = ["connection", "credentials", "settings", "systemPrompt"] as const;

type HostContext = Context & {
  connection: { rpc: Parameters<typeof registerTtsRpc>[0] };
  credentials: { resolve: (ref: ReturnType<typeof import("@deepseek-ai/dsh-credentials").credentialRef>) => Promise<{ value: string; source: string } | undefined> };
  settings: {
    register: (namespace: unknown, schema: unknown, options?: unknown) => { get(): unknown };
  };
  systemPrompt: { section: (section: unknown) => () => void };
};

export function apply(ctx: HostContext): void {
  const settings = ctx.settings.register(
    settingsNamespace(SETTINGS_NAMESPACE),
    QwenTtsSettingsSchema,
    { base: { voice: DEFAULT_VOICE }, applies: "live" }
  );
  const gateway = new QwenTtsGateway({
    credentials: ctx.credentials,
    getVoice: () => normalizeSettings(settings.get()).voice
  });
  registerTtsRpc(ctx.connection.rpc, gateway);
  registerTtsPrompt(ctx);
}

export { QwenTtsGateway, TtsGatewayError, registerTtsRpc, RPC_CHANNEL, RPC_ENDPOINT } from "./gateway.js";
export * from "./core.js";

export default { name, inject, apply };
