import z from "@deepseek-ai/schemastery";

export * from "./constants.js";

import {
  DEFAULT_ALIBABA_VOICE,
  DEFAULT_BYTEDANCE_VOICE,
  DEFAULT_PROVIDER,
  TTS_PROVIDERS,
  VOICE_ID_MAX_LENGTH
} from "./constants.js";

function voiceSchema(fallback: string) {
  return z.transform(
    z.string(),
    (value: string) => {
      const normalized = value.trim();
      // Keep the callback self-contained because Schemastery serializes it.
      if (!normalized || Array.from(normalized).length > 128) throw new TypeError("invalid voice id");
      return normalized;
    },
    true
  ).pattern(/\S/u).max(VOICE_ID_MAX_LENGTH).default(fallback).loose(true);
}

const alibabaVoice = voiceSchema(DEFAULT_ALIBABA_VOICE);
const bytedanceVoice = voiceSchema(DEFAULT_BYTEDANCE_VOICE);

const ttsSettingsShape = z.object({
  provider: z.union(TTS_PROVIDERS).default(DEFAULT_PROVIDER).loose(true),
  alibabaVoice,
  bytedanceVoice
});

/** Resolve only the current flat provider fields; obsolete unknown keys drop out. */
export const TtsSettingsSchema = z.transform(
  ttsSettingsShape,
  (value) => ({
    provider: value.provider,
    alibabaVoice: value.alibabaVoice,
    bytedanceVoice: value.bytedanceVoice
  }),
  true
).default({
  provider: DEFAULT_PROVIDER,
  alibabaVoice: DEFAULT_ALIBABA_VOICE,
  bytedanceVoice: DEFAULT_BYTEDANCE_VOICE
}).loose(true);

export type { TtsSettings } from "./constants.js";
