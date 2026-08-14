# Keep EventSource overflow reconnectable

## What happened

Wake-stream admission initially returned HTTP 429 when the host reached capacity, which could leave the renderer without future wake updates.

## Root cause

The renderer uses native `EventSource`; a non-200 response is not a reliable reconnect signal, every successful overflow handshake fires `open`, and authenticated request-body consumption can set request `destroyed` without closing the response.

## Rule

Return temporary overflow as a short SSE response with `retry:`, gate synchronization on a normal-stream-only event, and detect stale requests from abort/response state rather than request `destroyed`.
