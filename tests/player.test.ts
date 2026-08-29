import { describe, expect, it } from "vitest";
import { act, create } from "react-test-renderer";
import { createElement } from "react";

import { TtsAudioPill, TtsPlayer, type AudioLike } from "../src/player.js";
import type { BrowserAudioPayload } from "../src/gateway.js";

const payload: BrowserAudioPayload = { mediaType: "audio/mpeg", data: "SUQz", bytes: 3 };

function fakeAudio(log: { made: string[]; played: number; paused: number }[]): AudioLike & { finish(): void } {
  let ended: (() => void) | null = null;
  const audio: AudioLike & { finish(): void } = {
    currentTime: 0,
    get onended() { return ended; },
    set onended(value) { ended = value; },
    onerror: null,
    play: () => { log[0]!.played += 1; },
    pause: () => { log[0]!.paused += 1; },
    finish: () => ended?.()
  };
  return audio;
}

describe("manual TTS player", () => {
  it("does not call RPC until Play, then supports Stop and replay from received audio", async () => {
    let calls = 0;
    const log = [{ made: [] as string[], played: 0, paused: 0 }];
    const audios: Array<ReturnType<typeof fakeAudio>> = [];
    const player = new TtsPlayer({ synthesize: async () => { calls += 1; return payload; } }, (url) => {
      log[0]!.made.push(url);
      const audio = fakeAudio(log);
      audios.push(audio);
      return audio;
    });
    expect(player.getSnapshot().status).toBe("idle");
    await player.play("你好", "onoAnna");
    expect(calls).toBe(1);
    expect(player.getSnapshot().status).toBe("playing");
    audios[0]!.finish();
    expect(player.getSnapshot().status).toBe("idle");
    await player.play("你好", "onoAnna");
    expect(calls).toBe(1);
    expect(log[0]!.played).toBe(2);
    player.stop();
    expect(log[0]!.paused).toBe(1);
    player.dispose();
  });

  it("cancels pending RPC and ignores a late result", async () => {
    let settle!: (value: BrowserAudioPayload) => void;
    let created = 0;
    const player = new TtsPlayer({ synthesize: async () => new Promise<BrowserAudioPayload>((resolve) => { settle = resolve; }) }, () => {
      created += 1;
      return fakeAudio([{ made: [], played: 0, paused: 0 }]);
    });
    const pending = player.play("稍等", "onoAnna");
    expect(player.getSnapshot().status).toBe("loading");
    player.stop();
    settle(payload);
    await pending;
    expect(created).toBe(0);
    expect(player.getSnapshot().status).toBe("idle");
  });

  it("changes voice for future playback without stopping active audio", async () => {
    const log = [{ made: [] as string[], played: 0, paused: 0 }];
    let current!: ReturnType<typeof fakeAudio>;
    const player = new TtsPlayer({ synthesize: async () => payload }, (url) => {
      log[0]!.made.push(url);
      current = fakeAudio(log);
      return current;
    });
    await player.play("同一句", "onoAnna");
    player.setVoiceKey("maia");
    expect(player.getSnapshot().status).toBe("playing");
    expect(log[0]!.paused).toBe(0);
    player.stop();
  });

  it("keeps the transcript visible when synthesis fails", async () => {
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(TtsAudioPill, {
        text: "你好",
        transcript: "你好（旁白）",
        voiceKey: "onoAnna",
        client: { synthesize: async () => { throw new Error("unavailable"); } },
        audioFactory: () => fakeAudio([{ made: [], played: 0, paused: 0 }])
      }));
    });
    const button = root!.root.findByType("button");
    await act(async () => {
      button.props.onClick();
      await Promise.resolve();
    });
    const pill = root!.root.findByProps({ "data-tts-state": "error" });
    expect(pill.findByProps({ "data-tts-transcript": true }).children.join("")).toContain("你好（旁白）");
    expect(pill.findByProps({ role: "status" }).children.join("")).toContain("Audio unavailable");
    root!.unmount();
  });
});
