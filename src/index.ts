import type { Context } from "@deepseek-ai/cordis";

import {
  DEFAULT_ALIBABA_VOICE,
  DEFAULT_BYTEDANCE_VOICE,
  DEFAULT_PROVIDER,
  TtsSettingsSchema,
  SETTINGS_NAMESPACE,
} from "./settings.js";
import {
  KEPOS_TTS_SERVICE,
  TtsGateway,
  createKeposTtsService,
  registerTtsAudioRoute,
  registerTtsRpc,
  type KeposTtsService,
  type SessionResolver
} from "./gateway.js";
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
  provide: (name: string, value: unknown) => () => void;
};

export function apply(ctx: HostContext): void {
  const settings = ctx.settings.register(
    SETTINGS_NAMESPACE,
    TtsSettingsSchema,
    {
      base: {
        provider: DEFAULT_PROVIDER,
        alibabaVoice: DEFAULT_ALIBABA_VOICE,
        bytedanceVoice: DEFAULT_BYTEDANCE_VOICE
      },
      applies: "live"
    }
  );
  const gateway = new TtsGateway({
    credentials: ctx.credentials,
    sessions: ctx.sessions,
    getSettings: () => settings.get(),
    onFailure: (failure) => console.error("[kepos-tts] synthesis failed", failure)
  });
  registerTtsRpc(ctx.connection.rpc, gateway);
  ctx.provide(KEPOS_TTS_SERVICE, createKeposTtsService(gateway) satisfies KeposTtsService);
  ctx.effect(() => registerTtsAudioRoute(ctx.webServer, ctx.sessions), "kepos-tts: audio route");
  registerTtsPrompt(ctx);
}

export {
  TtsGateway,
  TtsGatewayError,
  KEPOS_TTS_SERVICE,
  createKeposTtsService,
  registerTtsAudioRoute,
  registerTtsRpc,
  RPC_CHANNEL,
  RPC_ENDPOINT,
  type KeposTtsAudio,
  type KeposTtsService,
  type KeposTtsSynthesisRequest,
  type KeposTtsTranscription,
  type KeposTtsTranscriptionRequest,
  type KeposTtsTranscriptionSentence
} from "./gateway.js";
export * from "./core.js";

export default { name, inject, apply };
