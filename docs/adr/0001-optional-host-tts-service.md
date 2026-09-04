# Optional Host TTS service

Date: 2026-09-04

## Status

Accepted

## Context

Kepos TTS already owns provider credentials, live-session validation, cache
identity, and bounded MP3 artifacts, but those capabilities were reachable
only through the browser Connection RPC. Another Host plugin should be able to
deliver trusted speech without routing through a browser transport or copying
provider integrations.

## Decision

The Kepos plugin publishes one optional Cordis service at `keposTts` while its
Host fiber is mounted. Its stable contract is:

```ts
interface KeposTtsService {
  synthesize(
    request: { sessionId: string; text: string },
    signal?: AbortSignal
  ): Promise<{ mediaType: "audio/mpeg"; data: Uint8Array }>;
}
```

The service delegates to the existing `TtsGateway`, so validation, session and
workspace resolution, provider and credential selection, deterministic cache
identity, provider invocation, and bounded artifact reads remain owned by
Kepos. It returns bytes only: consumers do not receive a browser URL or cache
path. Typed gateway failure categories remain the failure vocabulary, and no
provider diagnostic is placed in the service value.

The service is optional and is removed with the plugin lifecycle. Consumers
must read it with `ctx.get("keposTts")` and handle `undefined`; Kepos does not
inject consumers. The authenticated browser RPC and same-origin artifact route
remain unchanged for browser tagged-TTS behavior.

## Consequences

Host consumers can upload or otherwise process one bounded MP3 without knowing
about Web transport or cache layout. Deployments without Kepos TTS expose no
service, while mounted deployments retain one provider and cache owner. This
is an in-process Host seam, not a public synthesis endpoint or a streaming
audio API.
