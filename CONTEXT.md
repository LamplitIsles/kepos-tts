# Kepos TTS context

This glossary describes the ownership and boundaries of Kepos TTS's browser
and Host-facing synthesis paths.

## Language

**Tagged passage**:
The one finalized assistant passage enclosed by `[[tts:text]]` and
`[[/tts:text]]`. It is validated and normalized before synthesis; the tag is
audio-only and is never a provider or voice override.

**Browser TTS path**:
The authenticated Connection RPC and same-origin audio route used by the DSH
browser. It returns a workspace-owned URL and keeps native `<audio>` playback
unchanged.

**Host TTS service**:
The optional in-process Cordis service named `keposTts`. A Host plugin calls
`synthesize({ sessionId, text }, signal?)` and receives bounded MP3 bytes for a
live session. It has no browser URL, filesystem path, or public HTTP route.

**Live session**:
A DSH session that resolves to an absolute workspace cwd through the Host
session resolver. The session supplies both authorization context and the
workspace used for cache ownership.

**Workspace audio artifact**:
The deterministic, atomically written MP3 under
`.dsh/kepos-tts/audio/<sha256>.mp3`. Browser and Host synthesis share this
artifact and its bounded read contract.

**Provider profile**:
The normalized provider, provider model/resource identity, and Voice ID used
for one request and its cache key. Credentials are resolved separately and
never enter the profile identity or returned service value.
