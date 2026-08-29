import { createElement, Fragment, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { JsonBlock, MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives";
import type { AssistantBlock } from "@deepseek-ai/dsh-client-runtime/client";
import type { ChatNodeViewProps, RenderMessageImages } from "@deepseek-ai/dsh-client-ui-conversation/client";

import { parseTaggedText, type TaggedTextSegment } from "../parser.js";
import { TtsAudioPill, type TtsRpcClient } from "../player.js";

// The small block-family presentation below follows the MIT-licensed
// AssistantNodeView contract from the pinned DSH 0.1.1-rc.2 release. It keeps
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
  mentions?: unknown;
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
              rendered.push(createElement(TtsAudioPill, {
                key: `${index}-tts`,
                text: segment.text,
                transcript: segment.transcript,
                voiceKey: options.voiceKey!,
                client: options.client!
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
      rendered.push(createElement(
        "details",
        { key: index, className: "kepos-tts-reasoning", open: options.streaming && index === last },
        createElement("summary", null, options.t("message.reasoning", { default: "Reasoning" })),
        createElement("div", null, block.text)
      ));
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
    rendered.push(createElement("span", { className: "kepos-tts-stopped", key: "stopped" }, options.t("message.stopped", { default: "Stopped" })));
  }
  return rendered;
}

export function TtsAssistantNodeView(props: AssistantProps) {
  const data = props.node.data;
  const source = props.voiceSource ?? EMPTY_VOICE_SOURCE;
  const voiceKey = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const codeLabels = useMemo(() => ({
    copyLabel: props.t("copy"),
    copiedLabel: props.t("copied")
  }), [props.t]);
  const blocks = data.blocks ?? [];
  const streaming = data.status === "running";
  const interrupted = data.status === "interrupted";
  if (!(streaming || interrupted || blocks.some((block) => block.kind !== "tool-call"))) return null;
  let mentions: unknown;
  try {
    const finalNode = data.finalNode;
    const location = (props.node as unknown as { location?: { kind?: string; turn?: unknown } }).location;
    const turn = location?.kind === "turn" || location?.kind === "step" ? location.turn as { status?: string } : undefined;
    const tail = props.useTurnData?.("turn-tail");
    if (finalNode && turn?.status === "closed" && tail?.closing?.finalNode.seq === finalNode.seq && props.fileMentions && props.openFile) {
      mentions = props.fileMentions({
        turn: turn as never,
        seq: finalNode.seq,
        openFile: props.openFile
      } as never);
    }
  } catch {
    mentions = undefined;
  }
  return createElement(
    "div",
    { className: "kepos-tts-assistant", "data-streaming": streaming || undefined },
    ...renderAssistantBlocks(blocks, {
      streaming,
      interrupted,
      mentions,
      t: props.t as unknown as (key: string, params?: Record<string, unknown>) => string,
      client: props.client,
      voiceKey,
      codeLabels,
      renderMessageImages: props.renderMessageImages
    })
  );
}
