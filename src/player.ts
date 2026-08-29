import { createElement, useEffect, useRef, useSyncExternalStore } from "react";

import type { BrowserAudioPayload } from "./rpc.js";

export type TtsPlayerStatus = "idle" | "loading" | "playing" | "error";

export interface TtsPlayerSnapshot {
  status: TtsPlayerStatus;
  error?: string;
}

export interface TtsRpcClient {
  synthesize(text: string, signal?: AbortSignal): Promise<BrowserAudioPayload>;
}

export interface AudioLike {
  currentTime: number;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void> | void;
  pause(): void;
}

export type AudioFactory = (url: string) => AudioLike;

export interface TtsAudioPillProps {
  text: string;
  transcript?: string;
  voiceKey: string;
  client: TtsRpcClient;
  audioFactory?: AudioFactory;
  labels?: Partial<{ play: string; stop: string; replay: string; failed: string }>;
  className?: string;
}

const defaultAudioFactory: AudioFactory = (url) => new Audio(url) as unknown as AudioLike;

interface CachedAudio {
  text: string;
  voiceKey: string;
  url: string;
  revoke: boolean;
}

function payloadUrl(payload: BrowserAudioPayload): { url: string; revoke: boolean } {
  const bytes = (() => {
    const buffer = (globalThis as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;
    if (buffer) return new Uint8Array(buffer.from(payload.data, "base64"));
    const binary = atob(payload.data);
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
    return result;
  })();
  if (typeof URL !== "undefined" && typeof Blob !== "undefined" && typeof URL.createObjectURL === "function") {
    return { url: URL.createObjectURL(new Blob([bytes], { type: payload.mediaType })), revoke: true };
  }
  return { url: `data:${payload.mediaType};base64,${payload.data}`, revoke: false };
}

function revokeUrl(cached: CachedAudio | undefined): void {
  if (cached?.revoke && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(cached.url);
  }
}

/** Manual, cancellable audio lifecycle used by each inline conversation pill. */
export class TtsPlayer {
  private snapshot: TtsPlayerSnapshot = { status: "idle" };
  private readonly listeners = new Set<() => void>();
  private request: AbortController | undefined;
  private audio: AudioLike | undefined;
  private cached: CachedAudio | undefined;
  private stale: CachedAudio[] = [];
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly client: TtsRpcClient,
    private readonly audioFactory: AudioFactory = defaultAudioFactory
  ) {}

  getSnapshot = (): TtsPlayerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(snapshot: TtsPlayerSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private pauseAudio(): void {
    if (!this.audio) return;
    this.audio.onended = null;
    this.audio.onerror = null;
    try {
      this.audio.pause();
    } catch {
      // Browser audio implementations are allowed to throw during teardown.
    }
    this.audio = undefined;
    for (const cached of this.stale.splice(0)) revokeUrl(cached);
  }

  private drainStale(): void {
    for (const cached of this.stale.splice(0)) revokeUrl(cached);
  }

  setVoiceKey(voiceKey: string): void {
    if (this.cached && this.cached.voiceKey !== voiceKey) {
      if (this.audio) this.stale.push(this.cached);
      else revokeUrl(this.cached);
      this.cached = undefined;
    }
  }

  hasCached(text: string, voiceKey: string): boolean {
    return this.cached?.text === text && this.cached.voiceKey === voiceKey;
  }

  stop(): void {
    this.generation += 1;
    this.request?.abort();
    this.request = undefined;
    this.pauseAudio();
    if (!this.disposed) this.publish({ status: "idle" });
  }

  private async playUrl(url: string, generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    const audio = this.audioFactory(url);
    this.audio = audio;
    audio.onended = () => {
      if (generation !== this.generation || this.disposed) return;
      this.audio = undefined;
      this.drainStale();
      this.publish({ status: "idle" });
    };
    audio.onerror = () => {
      if (generation !== this.generation || this.disposed) return;
      this.audio = undefined;
      this.drainStale();
      this.publish({ status: "error", error: "audio-playback" });
    };
    this.publish({ status: "playing" });
    try {
      await audio.play();
    } catch {
      if (generation !== this.generation || this.disposed) return;
      this.audio = undefined;
      this.publish({ status: "error", error: "audio-playback" });
    }
  }

  async play(text: string, voiceKey: string): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.request?.abort();
    this.request = undefined;
    this.pauseAudio();
    if (this.cached?.text === text && this.cached.voiceKey === voiceKey) {
      await this.playUrl(this.cached.url, generation);
      return;
    }
    if (this.cached) {
      revokeUrl(this.cached);
      this.cached = undefined;
    }
    const controller = new AbortController();
    this.request = controller;
    this.publish({ status: "loading" });
    try {
      const payload = await this.client.synthesize(text, controller.signal);
      if (controller.signal.aborted || generation !== this.generation || this.disposed) return;
      this.request = undefined;
      const generated = payloadUrl(payload);
      this.cached = { text, voiceKey, ...generated };
      await this.playUrl(generated.url, generation);
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation || this.disposed) return;
      this.request = undefined;
      this.publish({ status: "error", error: error instanceof Error ? error.message : "synthesis-failed" });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.request?.abort();
    this.request = undefined;
    this.pauseAudio();
    revokeUrl(this.cached);
    this.cached = undefined;
    this.drainStale();
    this.listeners.clear();
  }
}

export function TtsAudioPill({
  text,
  transcript = text,
  voiceKey,
  client,
  audioFactory = defaultAudioFactory,
  labels,
  className
}: TtsAudioPillProps) {
  const playerRef = useRef<TtsPlayer | null>(null);
  if (!playerRef.current) playerRef.current = new TtsPlayer(client, audioFactory);
  const player = playerRef.current;
  const snapshot = useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
  useEffect(() => {
    player.setVoiceKey(voiceKey);
  }, [player, voiceKey]);
  useEffect(() => () => player.dispose(), [player]);

  const action = snapshot.status === "playing" || snapshot.status === "loading"
    ? "stop"
    : player.hasCached(text, voiceKey) ? "replay" : "play";
  const actionLabel = labels?.[action] ?? (action === "stop" ? "Stop" : action === "replay" ? "Replay" : "Play");
  const onClick = () => {
    if (action === "stop") player.stop();
    else void player.play(text, voiceKey);
  };
  return createElement(
    "span",
    { className: ["kepos-tts-pill", className].filter(Boolean).join(" "), "data-tts-state": snapshot.status },
    createElement("button", {
      type: "button",
      className: "kepos-tts-button",
      onClick,
      "aria-label": `${actionLabel}: ${transcript}`,
      "aria-busy": snapshot.status === "loading",
      disabled: false
    }, actionLabel),
    createElement("span", { className: "kepos-tts-transcript", "data-tts-transcript": true }, transcript),
    snapshot.status === "error"
      ? createElement("span", { className: "kepos-tts-error", role: "status" }, labels?.failed ?? "Audio unavailable; transcript shown.")
      : null
  );
}
