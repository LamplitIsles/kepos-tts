# Kepos TTS operator notes

This package is intended for a disposable or locally managed DSH Web bundle.
Build the package with Bun, run the typecheck/tests, and inspect the packed
client artifact before installing it into a Web profile. `bun run pack-smoke`
installs the tarball under a test-owned temporary `DSH_HOME`, checks the
Cordis host patch and exact browser loader id, and starts a test-owned
loopback server. It never touches a live DSH profile or credential.

After installation, configure the DashScope API key from Plugin Settings. The
card reports configured/source/writable state without rendering the key. A
successful tagged passage appears as a manual Play control; Stop aborts a
pending request and Replay uses already received MP3 bytes. If synthesis
fails, the transcript stays visible in the conversation.
