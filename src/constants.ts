export const SETTINGS_NAMESPACE = "kepos-tts";
export const CREDENTIAL_REF = "KEPOS_TTS_DASHSCOPE_API_KEY";
export const QWEN_MODEL = "qwen3-tts-flash";
export const DASHSCOPE_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
export const TTS_MAX_CHARS = 240;

export const VOICE_IDS = ["onoAnna", "maia", "momo"] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

export const VOICE_LABELS: Record<VoiceId, string> = {
  onoAnna: "Ono Anna",
  maia: "Maia",
  momo: "Momo"
};

export const DEFAULT_VOICE: VoiceId = "onoAnna";

export interface QwenTtsSettings {
  voice: VoiceId;
}
export function normalizeVoice(value: unknown): VoiceId {
  if (typeof value === "string" && (VOICE_IDS as readonly string[]).includes(value)) {
    return value as VoiceId;
  }
  if (typeof value === "object" && value !== null && "voice" in value) {
    return normalizeVoice((value as { voice?: unknown }).voice);
  }
  return DEFAULT_VOICE;
}

export function normalizeSettings(value: unknown): QwenTtsSettings {
  return { voice: normalizeVoice(value) };
}
