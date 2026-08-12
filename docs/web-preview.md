# Constrained web preview

The preview reads at most 256 KiB from the selected worktree's `package.json`
and starts only its declared `npm run dev` script. Oversized or changing
manifests fail before approval or process creation.
The local host spawns `npm` directly without a shell after one scoped approval.
On POSIX the process is placed in its own process group so stop and host
shutdown can terminate npm and its descendants (for example Vite) together;
Windows uses `taskkill /T`. Terminal preview records are released after a short
poll window so long-lived hosts do not retain every past session.
The preview URL must use HTTP or HTTPS on `localhost`, `127.0.0.1`, or `::1`.

The embedded frame has no popup, download, top-navigation, clipboard, camera,
microphone, geolocation, or display-capture authority. Navigation outside the
configured loopback origin is not accepted as preview context.

## Element references

A development application opts into element references by loading the bridge:

```html
<script src="http://127.0.0.1:4173/aldunis-preview-bridge.js"></script>
```

Use the actual Aldunis Code loopback origin when its port differs. The bridge
does nothing until the user selects **Reference element** and then clicks one
visible element. It returns only:

- a bounded selector, tag, role, accessible name, and short visible text;
- a bounded SVG snapshot of that element;
- an explicit error for hidden, stale, or frame-owned elements.

The host rejects messages from origins other than the configured preview
origin and caps received strings and image data. References and screenshots
remain in memory and are not added to local history automatically.

This opt-in page bridge is intentionally narrower than browser automation. It
does not expose arbitrary evaluation, navigation, form filling, credentials,
CAPTCHA handling, or background page inspection.

## Shared browser session

The desktop application can open a shared browser for a running loopback
preview. Aldunis owns the Electron `<webview>` and a conversation-scoped
`persist:aldunis-browser-*` partition; the provider and operator therefore see
the same page, cookies, and local page state. The normal workspace view and the
optional picture-in-picture window are mirrors of that one session.

The host exposes a small brokered MCP surface: status, bounded snapshots,
approved-preview-origin navigation, selector/coordinate clicks, focused text input, key
presses, scrolling, and short waits. It does not expose arbitrary CDP,
JavaScript evaluation, downloads, clipboard, browser permissions, credentials,
external URLs, or general-purpose command execution. The broker keeps page
text, screenshots, and action results transient rather than adding them to
conversation history.

Provider control is disabled when a session opens. **Allow agent control** is
an explicit session-scoped rule. Any human input changes the control epoch and
the broker rejects stale or human-controlled agent actions until the operator
returns control. Codex receives the MCP server through its app-server config;
the reviewed Grok ACP adapter receives it through the standard ACP stdio
`mcpServers` field. Other adapters retain the read-only observation fallback.

This is a desktop-only capability. Loopback web hosts and remote/managed hosts
do not receive a browser host or provider browser token.

## Floating live view

When the preview is running, **Float** detaches the same constrained iframe into
a small always-visible in-workbench window. This lets an operator keep the
conversation and local application visible together while an agent turn runs.
**Dock** returns it to the workspace panel.

Floating does not attach to an arbitrary Chrome session or to a provider-owned
browser. Codex and the reviewed Grok ACP adapter can use the separate shared
browser session described above when the desktop host is running; the floating
observation fallback remains available for providers that only expose inline
frames. The constrained iframe inherits the same loopback-only origin,
sandbox, denied browser permissions, and one-time start approval as the normal
preview.

## Provider browser observations

The provider event boundary now accepts an optional `browser_observation` frame
for adapters that explicitly receive inline JPEG, PNG, or WebP bytes. Aldunis
caps each frame, strips query strings from the displayed location, shows only
the latest frame in the floating view, and keeps it out of messages, activity,
checkpoints, and the local journal. The frame is read-only: it cannot be
clicked, navigated, or used to access provider credentials.

This is an adapter contract, not a browser attachment. The current Codex
app-server `imageView` item contains a local filesystem path, which Aldunis
intentionally ignores rather than reading arbitrary provider files. The
installed Grok ACP adapter does not currently advertise a browser observation
capability, so these providers will not populate the view until their protocol
exposes a bounded frame stream and the adapter is reviewed for it.
