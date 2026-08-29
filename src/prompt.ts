export const TTS_SYSTEM_PROMPT = [
  "Optional voice annotation (manual only): when a brief, characterful Chinese line would benefit from speech, you may mark exactly one short passage in the whole answer as [[tts:text]]...[[/tts:text]].",
  "Keep the passage to one short sentence and no more than 240 characters. It must be audio-only: do not repeat it elsewhere, and do not put code, tables, URLs, instructions, provider names, voice names, or emotion/control parameters inside the tag.",
  "Use no tag for ordinary technical replies. Never place a tag in a fenced code block. An unclosed or otherwise invalid tag is shown as normal text. The user decides whether to press Play; no audio is automatic."
].join(" ");

export function registerTtsPrompt(ctx: { systemPrompt?: { section: (...args: any[]) => any } }): (() => void) | undefined {
  if (!ctx.systemPrompt?.section) return undefined;
  return ctx.systemPrompt.section({
    name: "kepos-tts:tagged-output",
    order: 118,
    text: TTS_SYSTEM_PROMPT
  });
}
