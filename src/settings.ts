import z from "@deepseek-ai/schemastery";

export * from "./constants.js";

import { DEFAULT_VOICE, VOICE_IDS } from "./constants.js";

export const QwenTtsSettingsSchema = z.object({
  voice: z.union(VOICE_IDS).default(DEFAULT_VOICE)
});
