# Constrained web preview

The preview starts only a selected worktree's declared `npm run dev` script.
The local host spawns `npm` directly without a shell after one scoped approval.
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
