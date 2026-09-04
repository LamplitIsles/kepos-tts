# Kepos Speech

`@lamplitisles/kepos-speech` is a DeepSeek Harness Web plugin for Chinese
speech synthesis and short-audio recognition. It adds one optional audio-only
`[[tts:text]]...[[/tts:text]]` block to a finalized assistant reply, prepares
the resulting MP3, and replaces the block with the browser's native audio
player. The Host service also exposes bounded, synchronous Qwen ASR to trusted
in-process callers.

Locally transcribed user turns use a `🎙️ ` prefix and can end in a recognized
expression label such as `[neutral]`. The Speech system prompt defines both as
voice metadata: the marker identifies the source, and the label is an
audio-level ASR classification rather than message content or a claim about the
speaker's inner state.

Source: <https://github.com/LamplitIsles/kepos-speech>.

## Install for DSH

```sh
dsh plugin --profile <profile> add @lamplitisles/kepos-speech
```

The package is pinned to the DSH `0.1.2-rc.1` contract family and contains the
Host entry, browser loader, and `cordis.patch.yml` bundle patch. The packed
smoke test requires the official `@deepseek-ai/dsh@0.1.2-rc.1` CLI; set
`DSH_CLI` to that installed executable when it is not the default `dsh` on
`PATH`.

## Settings and providers

Open the native **Kepos Speech** Plugin Settings card from a local loopback
DSH Web session and choose Alibaba or ByteDance for tagged TTS output. The
editable Voice IDs default to `Maia` and
`zh_female_sajiaoxuemei_uranus_bigtts`; provider-supported IDs up to 128
characters are accepted. The DashScope key is shared by Alibaba TTS and the
fixed Qwen ASR path. The Volcengine key is used only for ByteDance TTS. Both
credential fields are write-only and are stored by DSH as
`KEPOS_SPEECH_DASHSCOPE_API_KEY` and `KEPOS_SPEECH_VOLCENGINE_API_KEY`.

The provider selector controls TTS output only. Qwen ASR is the sole
recognition provider and accepts one non-empty supported audio attachment up to
the documented 10 MB encoded bound. It returns complete text and optional
audio-level language and speech-expression annotations; it does not persist
audio or transcript content.

## Optional Host service

When mounted, the plugin publishes the optional Cordis service
`ctx.get("keposSpeech")`. A Host plugin can consume the exported
`KeposSpeechService` contract:

```ts
const speech = ctx.get("keposSpeech");
if (speech) {
  const audio = await speech.synthesize({ sessionId, text }, signal);
  // audio.mediaType === "audio/mpeg"; audio.data is bounded MP3 bytes

  const transcript = await speech.transcribe({
    sessionId,
    mediaType: "audio/ogg",
    data: attachmentBytes,
    language: "zh"
  }, signal);
  // transcript.text plus optional language/expression annotations
}
```

The service validates the live session and shares the workspace cache with
browser TTS. It is optional, is removed with the plugin lifecycle, and is not a
public transcription or synthesis route. Browser synthesis uses the
authenticated `/kepos-speech/synthesize` RPC and same-origin
`/kepos-speech/audio/...` artifacts.

## Audio cache

Each prepared passage is keyed by normalized text, provider profile, and cache
format, then written atomically as
`.dsh/kepos-speech/audio/<sha256>.mp3` below the active session workspace. A
refresh or remount resolves the session again and reuses the bounded artifact;
there is no browsing, migration, eviction, or cache-management UI.

## Maintainer release setup

The tag-only workflow in `.github/workflows/release.yml` verifies the exact
package that it publishes. Before the first automated release, a maintainer
must bootstrap a distinct prerelease version, then prepare the first stable
version:

1. Create or confirm the `@lamplitisles` npm scope and manually publish the
   initial `@lamplitisles/kepos-speech@0.1.0-beta.0` package so the package
   identity exists. Set `package.json` to `0.1.0-beta.0`, run the bootstrap checks
   below from a maintainer workstation, and publish with local npm
   authentication:

   ```sh
   bun install --frozen-lockfile
   bun run typecheck
   bun run test
   bun run build
   GITHUB_REF_NAME=v0.1.0-beta.0 bun run release:check
   npm publish --access public --tag beta
   ```

   This prerelease is deliberately distinct from the later stable `0.1.0`;
   do not manually publish `0.1.0`.
2. Change `package.json` to version `0.1.0` and commit that change, then
   configure npm Trusted Publishing for
   `@lamplitisles/kepos-speech`, repository
   `LamplitIsles/kepos-speech`, workflow
   `.github/workflows/release.yml`, and the GitHub `npm` environment.
3. Create the protected GitHub `npm` environment with the required approval
   policy.

For the first stable trusted publish, rerun the checks with the stable version,
push the committed version change, and create the tag with the supported `og`
operation (`og tag --help` describes this as “Create and push a tag”):

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
GITHUB_REF_NAME=v0.1.0 bun run release:check
og push
og tag v0.1.0
```

For each subsequent release, update `package.json` to the intended version,
run the local checks, push the committed change with `og push`, and create its
semantic version tag with `og tag v<version>` (for example, `og tag
v0.2.0-beta.1`). Tags must be `v<semver>` (for example `v0.1.0` or
`v0.2.0-beta.1`). Every purely numeric prerelease segment must be `0` or a
non-zero number without leading zeroes: `v1.2.3-0` and `v1.2.3-alpha01` are
valid, while `v1.2.3-01`, `v1.2.3-0.01`, and `v1.2.3-alpha.01` are rejected.
Build metadata such as `v1.2.3+build.1` is accepted. Stable tags publish to
npm as `latest`; prerelease tags publish as `beta`. The verify job performs an
immutable install, typecheck, tests, build, packed-artifact validation, and the
disposable DSH package smoke check before uploading the tarball consumed by the
publish job. Publishing uses npm OIDC provenance in the protected `npm`
environment with `id-token: write`; no npm token or repository secret is
configured or required for automated releases. The one-time bootstrap
publication uses the maintainer's local npm authentication only.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
GITHUB_REF_NAME=v0.1.0 bun run release:check
bun run pack-smoke
```

The smoke test uses test-owned temporary directories and never modifies a live
DSH profile, credential, or production service.
