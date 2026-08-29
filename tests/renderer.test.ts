import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";

import { renderAssistantBlocks } from "../src/client/assistant-node.js";
import type { TtsRpcClient } from "../src/player.js";

const client: TtsRpcClient = { synthesize: async () => ({ mediaType: "audio/mpeg", data: "SUQz", bytes: 3 }) };
const t = (key: string) => key;

describe("assistant renderer seam", () => {
  it("interleaves one finalized pill and leaves ordinary markdown rendered", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, renderAssistantBlocks([
      { kind: "text", text: "普通 [[tts:text]]你好[[/tts:text]]。" }
    ], { streaming: false, interrupted: false, t, client, voiceKey: "onoAnna" })));
    expect(html).toContain("kepos-tts-pill");
    expect(html).toContain("普通");
    expect(html).toContain("你好");
  });

  it("does not expose a control while streaming or for ordinary text", () => {
    const streaming = renderToStaticMarkup(createElement(Fragment, null, renderAssistantBlocks([{ kind: "text", text: "[[tts:text]]稍后[[/tts:text]]" }], { streaming: true, interrupted: false, t, client, voiceKey: "onoAnna" })));
    const ordinary = renderToStaticMarkup(createElement(Fragment, null, renderAssistantBlocks([{ kind: "text", text: "只是回答" }], { streaming: false, interrupted: false, t, client, voiceKey: "onoAnna" })));
    expect(streaming).not.toContain("kepos-tts-pill");
    expect(ordinary).not.toContain("kepos-tts-pill");
  });

  it("keeps the pinned Think row and native block path for untagged replies", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, renderAssistantBlocks([
      { kind: "reasoning", text: "先判断\n再回答" },
      { kind: "text", text: "普通回复" }
    ], { streaming: false, interrupted: false, t })));
    expect(html).toContain('data-variant="think"');
    expect(html).toContain('data-state="ok"');
    expect(html).toContain("Think");
    expect(html).toContain('data-disclosure-row="true"');
    expect(html).toContain("先判断");
    expect(html).toContain("普通回复");
    expect(html).not.toContain("kepos-tts-pill");
  });
});
