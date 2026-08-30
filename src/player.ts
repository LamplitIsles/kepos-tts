import { createElement, useEffect, useRef, useSyncExternalStore } from "react";

import type { BrowserAudioPayload } from "./rpc.js";
import styles from "./client/tts.module.dshcss";

export type TtsPlayerStatus = "idle" | "loading" | "ready" | "error";

export interface TtsPlayerSnapshot {
  status: TtsPlayerStatus;
  error?: string;
}

export interface TtsRpcClient {
  synthesize(text: string, signal?: AbortSignal): Promise<BrowserAudioPayload>;
}

export interface TtsAudioPlayerProps {
  text: string;
  transcript?: string;
  voiceKey: string;
  client: TtsRpcClient;
  labels?: Partial<{ preparing: string; audio: string; failed: string }>;
  className?: string;
}

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

/** Fetches tagged speech as soon as the finalized message mounts; playback remains native browser UI. */
export class TtsPlayer {
  private snapshot: TtsPlayerSnapshot = { status: "idle" };
  private readonly listeners = new Set<() => void>();
  private request: AbortController | undefined;
  private cached: CachedAudio | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly client: TtsRpcClient) {}

  getSnapshot = (): TtsPlayerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(snapshot: TtsPlayerSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  hasCached(text: string, voiceKey: string): boolean {
    return this.cached?.text === text && this.cached.voiceKey === voiceKey;
  }

  preparedUrl(text: string, voiceKey: string): string | undefined {
    return this.hasCached(text, voiceKey) ? this.cached?.url : undefined;
  }

  async prepare(text: string, voiceKey: string): Promise<void> {
    if (this.disposed) return;
    if (this.hasCached(text, voiceKey)) {
      this.publish({ status: "ready" });
      return;
    }
    const generation = ++this.generation;
    this.request?.abort();
    this.request = undefined;
    revokeUrl(this.cached);
    this.cached = undefined;
    const controller = new AbortController();
    this.request = controller;
    this.publish({ status: "loading" });
    try {
      const payload = await this.client.synthesize(text, controller.signal);
      if (controller.signal.aborted || generation !== this.generation || this.disposed) return;
      this.request = undefined;
      this.cached = { text, voiceKey, ...payloadUrl(payload) };
      this.publish({ status: "ready" });
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
    revokeUrl(this.cached);
    this.cached = undefined;
    this.listeners.clear();
  }
}

export function TtsAudioPlayer({
  text,
  transcript = text,
  voiceKey,
  client,
  labels,
  className
}: TtsAudioPlayerProps) {
  const playerRef = useRef<TtsPlayer | null>(null);
  if (!playerRef.current) playerRef.current = new TtsPlayer(client);
  const player = playerRef.current;
  const preparationRef = useRef<{ text: string; voiceKey: string } | null>(null);
  if (!preparationRef.current) preparationRef.current = { text, voiceKey };
  const preparation = preparationRef.current;
  const snapshot = useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
  useEffect(() => {
    void player.prepare(preparation.text, preparation.voiceKey);
  }, [player, preparation]);
  useEffect(() => () => player.dispose(), [player]);

  const src = player.preparedUrl(preparation.text, preparation.voiceKey);
  const classes = [styles.player, className].filter(Boolean).join(" ");
  if (snapshot.status === "ready" && src) {
    return createElement(
      "div",
      { className: classes, "data-tts-state": snapshot.status },
      createElement("span", { className: styles.playerLabel }, labels?.audio ?? "Audio message"),
      createElement("audio", {
        controls: true,
        preload: "metadata",
        src,
        "aria-label": `${labels?.audio ?? "Audio message"}: ${transcript}`
      })
    );
  }
  if (snapshot.status === "error") {
    return createElement(
      "div",
      { className: classes, "data-tts-state": snapshot.status },
      createElement("span", { className: styles.transcript, "data-tts-transcript": true }, transcript),
      createElement("span", { className: styles.error, role: "status" }, labels?.failed ?? "Audio unavailable; transcript shown.")
    );
  }
  return createElement(
    "div",
    { className: classes, "data-tts-state": snapshot.status, "aria-busy": true },
    createElement("span", { className: styles.preparing, role: "status" }, labels?.preparing ?? "Preparing audio…")
  );
}
