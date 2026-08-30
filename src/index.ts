import type { Context } from "@deepseek-ai/cordis";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

import {
  DEFAULT_VOICE,
  QwenTtsSettingsSchema,
  SETTINGS_NAMESPACE,
  normalizeSettings
} from "./settings.js";
import { QwenTtsGateway, registerTtsAudioRoute, registerTtsRpc, type SessionResolver } from "./gateway.js";
import { registerTtsPrompt } from "./prompt.js";

export const name = "kepos-tts";
export const inject = ["connection", "credentials", "settings", "systemPrompt", "sessions", "webServer"] as const;

type HostContext = Context & {
  connection: { rpc: Parameters<typeof registerTtsRpc>[0] };
  credentials: { resolve: (ref: ReturnType<typeof import("@deepseek-ai/dsh-credentials").credentialRef>) => Promise<{ value: string; source: string } | undefined> };
  settings: {
    register: (namespace: unknown, schema: unknown, options?: unknown) => { get(): unknown };
  };
  systemPrompt: { section: (section: unknown) => () => void };
  sessions: SessionResolver;
  webServer: {
    register: Parameters<typeof registerTtsAudioRoute>[0]["register"];
  };
};

export function apply(ctx: HostContext): void {
  const settings = ctx.settings.register(
    settingsNamespace(SETTINGS_NAMESPACE),
    QwenTtsSettingsSchema,
    { base: { voice: DEFAULT_VOICE }, applies: "live" }
  );
  const gateway = new QwenTtsGateway({
    credentials: ctx.credentials,
    sessions: ctx.sessions,
    getVoice: () => normalizeSettings(settings.get()).voice
  });
  registerTtsRpc(ctx.connection.rpc, gateway);
  ctx.effect(() => registerTtsAudioRoute(ctx.webServer, ctx.sessions), "kepos-tts: audio route");
  registerTtsPrompt(ctx);
}

export {
  QwenTtsGateway,
  TtsGatewayError,
  registerTtsAudioRoute,
  registerTtsRpc,
  RPC_CHANNEL,
  RPC_ENDPOINT
} from "./gateway.js";
export * from "./core.js";

export default { name, inject, apply };
