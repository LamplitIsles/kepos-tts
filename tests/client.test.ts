import { describe, expect, it } from "vitest";

import { createTtsRpcClient } from "../src/client.js";
import { RPC_CHANNEL, RPC_ENDPOINT } from "../src/rpc.js";

describe("createTtsRpcClient", () => {
  it("carries text and framework session identity in the RPC envelope", async () => {
    const calls: unknown[][] = [];
    const connection = {
      rpc: {
        call: async (...args: unknown[]) => {
          calls.push(args);
          return {
            ok: true,
            value: {
              mediaType: "audio/mpeg",
              url: "/kepos-tts/audio/a.mp3?sessionId=session-a",
              bytes: 3
            }
          };
        }
      }
    };

    await createTtsRpcClient(connection as never).synthesize("你好", "session-a");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual([
      RPC_CHANNEL,
      RPC_ENDPOINT,
      { text: "你好", sessionId: "session-a" }
    ]);
  });
});
