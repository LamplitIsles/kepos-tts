# Kepos TTS operator notes

This package is intended for a disposable or locally managed DSH Web bundle.
Build the package with Bun, run the typecheck/tests, and inspect the packed
client artifact before installing it into a Web profile. `bun run pack-smoke`
installs the tarball under a disposable test-owned `DSH_HOME`, starts the
installed DSH Web runtime on a test-owned loopback port, and verifies the real
host patch, Settings registration, RPC route, and browser loader. It never
touches a live DSH profile or credential.

Configure the DashScope API key and persistent voice from a local loopback DSH
Web Settings session. The card reports configured/source/writable state without
rendering the key. A Kepos-published URL can play tagged TTS after that local
setup, but its remote Settings card must not promise credential or voice
writes; there is no remote configuration endpoint. A successful tagged passage
appears as a manual Play control; Stop aborts a pending request and Replay uses
already received MP3 bytes. If synthesis fails, the transcript stays visible in
the conversation.
