# kepos-tts

Dual-provider Chinese tagged text-to-speech for DeepSeek Harness Web. The bundle
adds one optional audio-only `[[tts:text]]...[[/tts:text]]` block to a finalized
assistant reply. When that message completes, it immediately prepares its MP3
and replaces the block with the browser's native audio player. Normal replies,
malformed tags, and fenced examples remain ordinary visible text.

## Build and verify

```sh
bun install
bun run typecheck
bun run test
bun run build
bun run pack-smoke
```

The resulting package contains a host ESM entry, a browser loader entry, and
`cordis.patch.yml`. It is pinned to the DSH `0.1.2-alpha.3` contract family.
The packed smoke test requires a `dsh` CLI reporting that exact version; set
`DSH_CLI` when it is not the default executable on `PATH`.

## Settings

Open the native Plugin Settings card from a local loopback DSH Web session and
choose Alibaba or ByteDance. The editable Voice ID defaults are `Maia` and
`zh_female_sajiaoxuemei_uranus_bigtts`; any provider-supported ID up to 128
characters can be entered. Store the selected provider's key using the card's
write-only password field. DSH credentials hold Alibaba under
`KEPOS_TTS_DASHSCOPE_API_KEY` and ByteDance under
`KEPOS_TTS_VOLCENGINE_API_KEY`; this plugin never reads or displays saved
values. There is no agenix or remote configuration path. In remote DSH Web, an
unavailable or memory-backed Settings scope does not render this card; only a
ready non-writable Host scope shows it read-only.

Alibaba uses Qwen3-TTS Flash with Chinese MP3 output. ByteDance uses the
domestic Volcengine V3 `seed-tts-2.0` one-shot SSE endpoint with MP3 at 24
kHz. The host accepts only the finalized passage and framework session identity
sent by the browser's trusted Connection RPC; provider and voice are never
message overrides.

## Optional Host service

When this plugin is mounted, it publishes the optional Cordis service
`ctx.get("keposTts")`. A Host plugin can call the exported
`KeposTtsService` contract:

```ts
const tts = ctx.get("keposTts");
if (tts) {
  const audio = await tts.synthesize({ sessionId, text }, signal);
  // audio.mediaType === "audio/mpeg"; audio.data is bounded MP3 bytes
}
```

The service validates the live session and text, resolves the configured
provider and credential, and shares the workspace cache with browser TTS. It
returns only `{ mediaType: "audio/mpeg", data: Uint8Array }`; it never returns
a browser URL or cache path. The service is optional and disappears with the
Kepos plugin fiber. This is an in-process Host seam for non-browser consumers,
not a public HTTP synthesis route and not a replacement for the authenticated
browser RPC.

## Audio cache

Each prepared passage is keyed by its normalized text, selected provider
profile (provider, model/resource, and Voice ID), and cache format, then written
atomically as
`.dsh/kepos-tts/audio/<sha256>.mp3` below the active session workspace. A
refresh or remount resolves the session again and reuses that bounded artifact;
the browser only receives a same-origin `/kepos-tts/audio/...` URL. The cache
has no browsing, eviction, migration, or clear UI, and sessions without an
absolute workspace are intentionally unavailable.
