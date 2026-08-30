import {
  createElement,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type { ReactNode } from "react";
import { DisclosureRow, IconThinkOutline14, JsonBlock, MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives";
import type { AssistantBlock } from "@deepseek-ai/dsh-client-runtime/client";
import type { ChatNodeViewProps, RenderMessageImages } from "@deepseek-ai/dsh-client-ui-conversation/client";

import { parseTaggedText, type TaggedTextSegment } from "../parser.js";
import { TtsAudioPlayer, type TtsRpcClient } from "../player.js";
import styles from "./tts.module.dshcss";

// The block-family presentation below adapts the MIT-licensed
// AssistantMarkdown/ReasoningRow presentation from the pinned DSH
// 0.1.1-rc.2 release (@deepseek-ai/dsh-client-ui-conversation). It keeps
// markdown, reasoning, images, unknown blocks, interruption markers, and file
// mentions intact while changing only finalized prose rendering.

export interface VoiceSource {
  getSnapshot(): string;
  subscribe(listener: () => void): () => void;
}

const EMPTY_VOICE_SOURCE: VoiceSource = {
  getSnapshot: () => "onoAnna",
  subscribe: () => () => undefined
};

type AssistantProps = ChatNodeViewProps<"assistant-step"> & {
  client?: TtsRpcClient;
  voiceSource?: VoiceSource;
};

type MarkdownCodeLabels = { copyLabel: string; copiedLabel: string };

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

function latestLine(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf("\n");
  return newline === -1 ? visible : visible.slice(newline + 1);
}

/**
 * Adapted from DSH's frame-throttled visual alignment helper. The synchronous
 * fallback keeps this renderer safe in non-browser test environments.
 */
function useThrottledVisualUpdate(update: () => void, intervalFrames = 3): () => void {
  const updateRef = useRef(update);
  updateRef.current = update;
  const pendingFrameRef = useRef<number | null>(null);
  useIsomorphicLayoutEffect(() => () => {
    if (pendingFrameRef.current === null || typeof cancelAnimationFrame !== "function") return;
    cancelAnimationFrame(pendingFrameRef.current);
    pendingFrameRef.current = null;
  }, []);
  return useCallback(() => {
    if (pendingFrameRef.current !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      updateRef.current();
      return;
    }
    let remainingFrames = intervalFrames;
    const advance = () => {
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        pendingFrameRef.current = requestAnimationFrame(advance);
        return;
      }
      pendingFrameRef.current = null;
      updateRef.current();
    };
    pendingFrameRef.current = requestAnimationFrame(advance);
  }, [intervalFrames]);
}

interface ReasoningRowProps {
  text: string;
  running: boolean;
  t: (key: string, params?: Record<string, unknown>) => string;
}

/** The pinned DSH Think disclosure, kept independent from tool presentation. */
function ReasoningRow({ text, running, t }: ReasoningRowProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const summaryRef = useRef<HTMLSpanElement | null>(null);
  const summary = running ? latestLine(text) : firstLine(text);
  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current;
    if (element === null) return;
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0;
  });
  useEffect(() => {
    scheduleSummaryScroll();
  }, [running, scheduleSummaryScroll, summary]);
  return createElement(
    "div",
    {
      className: styles.reasoningRoot,
      "data-variant": "think",
      "data-state": running ? "running" : "ok"
    },
    running ? createElement("span", { className: styles.visuallyHidden }, t("row.running")) : null,
    createElement(DisclosureRow, {
      rowClassName: styles.reasoningRow,
      leadingClassName: styles.reasoningLeading,
      titleClassName: styles.reasoningTitle,
      chevronClassName: styles.reasoningChevron,
      icon: createElement(IconThinkOutline14, { size: 14 }),
      title: "Think",
      open: expanded,
      expandable: true,
      expandOnRowClick: true,
      onToggle: () => setExpanded((value) => !value),
      collapsedContent: createElement(
        Fragment,
        null,
        createElement("span", { className: styles.reasoningSeparator, "aria-hidden": true }),
        createElement(
          "span",
          {
            ref: summaryRef,
            className: styles.reasoningSummary,
            "data-follow-end": running || undefined
          },
          summary
        )
      ),
      children: createElement("div", { className: styles.reasoningBody }, text)
    })
  );
}

function normalText(
  segment: TaggedTextSegment,
  key: string | number,
  streaming: boolean,
  mentions: unknown,
  codeLabels?: MarkdownCodeLabels
): ReactNode {
  if (segment.kind === "tts") return null;
  return createElement(MarkdownText, {
    key,
    text: segment.text,
    streaming,
    fileMentions: mentions as never,
    codeLabels
  });
}

export interface RenderAssistantBlocksOptions {
  streaming: boolean;
  interrupted: boolean;
  sessionId?: string | undefined;
  mentions?: unknown | undefined;
  t: (key: string, params?: Record<string, unknown>) => string;
  client?: TtsRpcClient | undefined;
  voiceKey?: string | undefined;
  renderMessageImages?: RenderMessageImages | undefined;
  codeLabels?: MarkdownCodeLabels | undefined;
}

/** Render the stock assistant block families, intercepting only final prose. */
export function renderAssistantBlocks(blocks: readonly AssistantBlock[], options: RenderAssistantBlocksOptions): ReactNode[] {
  const rendered: ReactNode[] = [];
  let claimed = false;
  const last = blocks.length - 1;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    if (block.kind === "text") {
      if (!options.streaming && !options.interrupted && !claimed && options.client && options.voiceKey) {
        const parsed = parseTaggedText(block.text);
        if (parsed.passage) {
          claimed = true;
          parsed.segments.forEach((segment, segmentIndex) => {
            if (segment.kind === "tts") {
              rendered.push(createElement(TtsAudioPlayer, {
                key: `${index}-tts`,
                text: segment.text,
                transcript: segment.transcript,
                voiceKey: options.voiceKey!,
                sessionId: options.sessionId,
                client: options.client!,
                labels: {
                  preparing: options.t("message.preparingAudio", { default: "Preparing audio…" }),
                  audio: options.t("message.audio", { default: "Audio message" }),
                  failed: options.t("message.audioUnavailable", { default: "Audio unavailable; transcript shown." })
                }
              }));
            } else {
              rendered.push(normalText(
                segment,
                `${index}-${segmentIndex}`,
                options.streaming,
                options.mentions,
                options.codeLabels
              ));
            }
          });
          continue;
        }
      }
      rendered.push(createElement(MarkdownText, {
        key: index,
        text: block.text,
        streaming: options.streaming,
        fileMentions: options.mentions as never,
        codeLabels: options.codeLabels
      }));
      continue;
    }
    if (block.kind === "reasoning") {
      rendered.push(createElement(ReasoningRow, {
        key: index,
        text: block.text,
        running: options.streaming && index === last,
        t: options.t
      }));
      continue;
    }
    if (block.kind === "image") {
      const images = [{ attachment: block.attachment }];
      while (index + 1 < blocks.length && blocks[index + 1]?.kind === "image") {
        index += 1;
        const image = blocks[index];
        if (image?.kind === "image") images.push({ attachment: image.attachment });
      }
      if (options.renderMessageImages) {
        rendered.push(createElement(Fragment, { key: `${index}-images` }, options.renderMessageImages({ images, align: "start" })));
      }
      continue;
    }
    if (block.kind === "tool-call") continue;
    rendered.push(createElement(JsonBlock, {
      key: index,
      label: options.t("message.unknownBlock", { default: "Unknown message block" }),
      payload: block.block,
      truncatedLabel: (total: number) => options.t("json.truncated", { total })
    }));
  }
  if (options.interrupted) {
    rendered.push(createElement("span", { className: styles.stopped, key: "stopped" }, options.t("message.stopped", { default: "Stopped" })));
  }
  return rendered;
}

interface AssistantMarkdownProps {
  blocks: readonly AssistantBlock[];
  streaming: boolean;
  interrupted: boolean;
  sessionId?: string | undefined;
  mentions?: unknown;
  t: (key: string, params?: Record<string, unknown>) => string;
  client?: TtsRpcClient | undefined;
  voiceKey?: string | undefined;
  renderMessageImages?: RenderMessageImages | undefined;
}

/** Pinned AssistantMarkdown root/body shape with the prose seam added. */
function AssistantMarkdown({
  blocks,
  streaming,
  interrupted,
  sessionId,
  mentions,
  t,
  client,
  voiceKey,
  renderMessageImages
}: AssistantMarkdownProps): ReactNode {
  const codeLabels = useMemo(() => ({
    copyLabel: t("copy"),
    copiedLabel: t("copied")
  }), [t]);
  if (!(streaming || interrupted || blocks.some((block) => block.kind !== "tool-call"))) return null;
  return createElement(
    "div",
    { className: styles.assistant, "data-streaming": streaming || undefined },
    createElement(
      "div",
      { className: styles.assistantBody },
      renderAssistantBlocks(blocks, {
        streaming,
        interrupted,
        sessionId,
        mentions,
        t,
        client,
        voiceKey,
        codeLabels,
        renderMessageImages
      })
    )
  );
}

export function TtsAssistantNodeView(props: AssistantProps) {
  const data = props.node.data;
  const source = props.voiceSource ?? EMPTY_VOICE_SOURCE;
  const voiceKey = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const blocks = data.blocks ?? [];
  const streaming = data.status === "running";
  const interrupted = data.status === "interrupted";
  const location = (props.node as unknown as { location?: { kind?: string; turn?: { status?: string } } }).location;
  const turn = location?.kind === "turn" || location?.kind === "step" ? location.turn : undefined;
  const tail = props.useTurnData?.("turn-tail");
  const owner = useMemo(() => {
    const finalNode = data.finalNode;
    if (turn?.status !== "closed" || finalNode === undefined) return undefined;
    if (tail?.closing?.finalNode.seq !== finalNode.seq) return undefined;
    return { turn, seq: finalNode.seq, openFile: props.openFile };
  }, [data.finalNode, props.openFile, tail, turn]);
  const mentions = useMemo(() => owner === undefined ? undefined : props.fileMentions(owner as never), [owner, props.fileMentions]);
  return createElement(AssistantMarkdown, {
    blocks,
    streaming,
    interrupted,
    sessionId: props.sessionId,
    mentions,
    t: props.t as unknown as (key: string, params?: Record<string, unknown>) => string,
    client: props.client,
    voiceKey,
    renderMessageImages: props.renderMessageImages
  });
}
