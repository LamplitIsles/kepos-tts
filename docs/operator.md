# Kepos TTS operator notes

This package is intended for a disposable or locally managed DSH Web bundle.
Build the package with Bun, run the typecheck/tests, and inspect the packed
client artifact before installing it into a Web profile. `bun run pack-smoke`
installs the tarball under a disposable test-owned `DSH_HOME`, starts the
installed DSH Web runtime on a test-owned loopback port, and verifies the real
host patch, Settings registration, RPC route, and browser loader. It never
touches a live DSH profile or credential.

Configure the DashScope API key and persistent voice from a local loopback DSH
Web Settings session. The card reports configured state and read-only access
without rendering the key. A Kepos-published URL can play tagged TTS after that
local setup, but its remote Settings card must not promise credential or voice
writes; there is no remote configuration endpoint. When a tagged message
completes, the browser immediately prepares its MP3 and replaces the tag with
the browser's native audio player. If synthesis fails, the transcript stays
visible in the conversation.

Artifacts live under the session's immutable workspace cwd at
`.dsh/kepos-tts/audio/<sha256>.mp3`. The Host validates the session and digest
again when serving `/kepos-tts/audio/<digest>.mp3?sessionId=...`, so a client
cannot select another workspace path. Cache writes are bounded and atomic; a
second request, another gateway instance, or a later page visit reuses the
artifact without another provider call. Remove files manually only as part of
workspace maintenance—the plugin intentionally provides no cache-management
surface.
