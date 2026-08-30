/** Shared settings and provider identity for the host and browser halves. */
export const SETTINGS_NAMESPACE = "kepos-tts";

export const ALIBABA_CREDENTIAL_REF = "KEPOS_TTS_DASHSCOPE_API_KEY";
export const BYTEDANCE_CREDENTIAL_REF = "KEPOS_TTS_VOLCENGINE_API_KEY";

export const DASHSCOPE_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
export const ALIBABA_MODEL = "qwen3-tts-flash";

export const BYTEDANCE_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
export const BYTEDANCE_RESOURCE_ID = "seed-tts-2.0";

export const TTS_MAX_CHARS = 240;
export const VOICE_ID_MAX_LENGTH = 128;

export const DEFAULT_PROVIDER = "alibaba" as const;
export const DEFAULT_ALIBABA_VOICE = "Maia";
export const DEFAULT_BYTEDANCE_VOICE = "zh_female_sajiaoxuemei_uranus_bigtts";

export const TTS_PROVIDERS = ["alibaba", "bytedance"] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export interface TtsSettings {
  provider: TtsProvider;
  alibabaVoice: string;
  bytedanceVoice: string;
}

/** The normalized provider profile used by synthesis and cache identity. */
export interface TtsProfile {
  provider: TtsProvider;
  voice: string;
  /** Provider model/resource identity; never supplied by the browser. */
  model: string;
  credentialRef: string;
}

export function normalizeProvider(value: unknown): TtsProvider {
  return typeof value === "string" && (TTS_PROVIDERS as readonly string[]).includes(value)
    ? value as TtsProvider
    : DEFAULT_PROVIDER;
}

/** Trim a configured Voice ID while treating malformed values as defaults. */
export function normalizeVoiceId(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > VOICE_ID_MAX_LENGTH) return fallback;
  return normalized;
}

export function normalizeSettings(value: unknown): TtsSettings {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    provider: normalizeProvider(record.provider),
    alibabaVoice: normalizeVoiceId(record.alibabaVoice, DEFAULT_ALIBABA_VOICE),
    bytedanceVoice: normalizeVoiceId(record.bytedanceVoice, DEFAULT_BYTEDANCE_VOICE)
  };
}

export function profileFromSettings(value: unknown): TtsProfile {
  const settings = normalizeSettings(value);
  if (settings.provider === "bytedance") {
    return {
      provider: "bytedance",
      voice: settings.bytedanceVoice,
      model: BYTEDANCE_RESOURCE_ID,
      credentialRef: BYTEDANCE_CREDENTIAL_REF
    };
  }
  return {
    provider: "alibaba",
    voice: settings.alibabaVoice,
    model: ALIBABA_MODEL,
    credentialRef: ALIBABA_CREDENTIAL_REF
  };
}

/** A secret-free, stable page-memory identity for one normalized profile. */
export function providerProfileKey(value: unknown): string {
  const profile = profileFromSettings(value);
  return JSON.stringify([profile.provider, profile.model, profile.voice]);
}
