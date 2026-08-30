import { describe, expect, it } from "vitest";
import { act, create } from "react-test-renderer";
import { createElement } from "react";

import { TtsAudioPlayer, TtsPlayer } from "../src/player.js";
import type { BrowserAudioPayload } from "../src/gateway.js";

const payload: BrowserAudioPayload = { mediaType: "audio/mpeg", data: "SUQz", bytes: 3 };

describe("tagged TTS player", () => {
  it("prefetches audio when the finalized message mounts and renders a native player", async () => {
    let calls = 0;
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(TtsAudioPlayer, {
        text: "你好",
        voiceKey: "onoAnna",
        client: { synthesize: async () => { calls += 1; return payload; } }
      }));
      await Promise.resolve();
    });
    expect(calls).toBe(1);
    const audio = root!.root.findByType("audio");
    expect(audio.props.controls).toBe(true);
    expect(audio.props.preload).toBe("metadata");
    root!.unmount();
  });

  it("prepares each text and voice only once", async () => {
    let calls = 0;
    const player = new TtsPlayer({ synthesize: async () => { calls += 1; return payload; } });
    await player.prepare("你好", "onoAnna");
    expect(calls).toBe(1);
    expect(player.getSnapshot().status).toBe("ready");
    expect(player.preparedUrl("你好", "onoAnna")).toBeTruthy();
    await player.prepare("你好", "onoAnna");
    expect(calls).toBe(1);
    player.dispose();
  });

  it("cancels a pending request when the message unmounts", async () => {
    let settle!: (value: BrowserAudioPayload) => void;
    const player = new TtsPlayer({ synthesize: async () => new Promise<BrowserAudioPayload>((resolve) => { settle = resolve; }) });
    const pending = player.prepare("稍等", "onoAnna");
    expect(player.getSnapshot().status).toBe("loading");
    player.dispose();
    settle(payload);
    await pending;
    expect(player.preparedUrl("稍等", "onoAnna")).toBeUndefined();
  });

  it("keeps an already prepared player stable when the selected voice changes", async () => {
    let calls = 0;
    let root: ReturnType<typeof create> | undefined;
    const client = { synthesize: async () => { calls += 1; return payload; } };
    await act(async () => {
      root = create(createElement(TtsAudioPlayer, { text: "同一句", voiceKey: "onoAnna", client }));
      await Promise.resolve();
    });
    const originalSrc = root!.root.findByType("audio").props.src;
    await act(async () => {
      root!.update(createElement(TtsAudioPlayer, { text: "同一句", voiceKey: "maia", client }));
      await Promise.resolve();
    });
    expect(calls).toBe(1);
    expect(root!.root.findByType("audio").props.src).toBe(originalSrc);
    root!.unmount();
  });

  it("keeps the transcript visible when prefetching fails", async () => {
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(TtsAudioPlayer, {
        text: "你好",
        transcript: "你好（旁白）",
        voiceKey: "onoAnna",
        client: { synthesize: async () => { throw new Error("unavailable"); } }
      }));
      await Promise.resolve();
    });
    const player = root!.root.findByProps({ "data-tts-state": "error" });
    expect(player.findByProps({ "data-tts-transcript": true }).children.join("")).toContain("你好（旁白）");
    expect(player.findByProps({ role: "status" }).children.join("")).toContain("Audio unavailable");
    root!.unmount();
  });
});
