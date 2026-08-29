# kepos-tts

Manual Chinese Qwen3-TTS Flash controls for DeepSeek Harness Web. The bundle
adds an optional `[[tts:text]]...[[/tts:text]]` annotation to finalized
assistant prose. A user must press Play; normal replies, malformed tags, and
fenced examples remain ordinary visible text.

## Build and verify

```sh
bun install
bun run typecheck
bun test
bun run build
bun run pack-smoke
```

The resulting package contains a host ESM entry, a browser loader entry, and
`cordis.patch.yml`. It is pinned to the DSH `0.1.1-rc.2` contract family.

## Settings

Open the native Plugin Settings card and choose Ono Anna (the default), Maia,
or Momo. Store the DashScope key using the card's password field. It is held
by DSH's credential provider under `KEPOS_TTS_DASHSCOPE_API_KEY`; this plugin
never reads or displays the saved value and has no custom endpoint setting.

The host gateway uses the fixed `qwen3-tts-flash` model, Chinese language, and
MP3 output. It accepts only the short text payload sent by the browser's
trusted Connection RPC.
