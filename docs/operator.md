# Kepos TTS operator notes

This package is intended for a disposable or locally managed DSH Web bundle.
Build the package with Bun, run the typecheck/tests, and inspect the packed
client artifact before installing it into a Web profile. `bun run pack-smoke`
installs the tarball under a disposable test-owned `DSH_HOME`, starts the
installed DSH Web runtime on a test-owned loopback port, and verifies the real
host patch, Settings registration, RPC route, and browser loader. It never
touches a live DSH profile or credential.

Configure Alibaba or ByteDance, its independent Voice ID, and its key from a
local loopback DSH Web Settings session. The defaults are `Maia` and
`zh_female_sajiaoxuemei_uranus_bigtts`, but Voice IDs are free-form (up to 128
characters). The card reports each selected credential's configured state and
never renders its value. DSH stores Alibaba under
`KEPOS_TTS_DASHSCOPE_API_KEY` and ByteDance under
`KEPOS_TTS_VOLCENGINE_API_KEY`; there is no agenix or remote configuration
endpoint. An unavailable or memory-backed remote Settings scope does not
render this card; a ready non-writable Host scope is read-only. Tagged TTS
still reaches the Host in those scopes, but page-memory preparation sharing
starts only after a real ready Host profile exists. When a tagged message
completes, the browser immediately prepares its MP3 and replaces the tag with the browser's native
audio player. If synthesis fails, the transcript stays visible.

Artifacts live under the session's immutable workspace cwd at
`.dsh/kepos-tts/audio/<sha256>.mp3`. The digest includes the normalized passage,
provider, model/resource, Voice ID, and cache format. The Host validates the
session and digest again when serving `/kepos-tts/audio/<digest>.mp3?sessionId=...`,
so a client cannot select another workspace path. Cache writes are bounded and
atomic; a second request, another gateway instance, or a later page visit
reuses the matching provider artifact without another provider call. Remove
files manually only as part of workspace maintenance—the plugin intentionally
provides no cache-management surface.
