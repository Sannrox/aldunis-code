(() => {
  const MAX_TEXT = 500;
  const MAX_MARKUP = 80_000;
  let active = null;

  function reply(target, origin, value) {
    target.postMessage(value, origin);
  }

  function selectorFor(element) {
    if (element.id) return `#${CSS.escape(element.id)}`.slice(0, 240);
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 5) {
      let part = current.localName;
      const parent = current.parentElement;
      if (parent) {
        const peers = [...parent.children].filter((item) => item.localName === current.localName);
        if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ").slice(0, 240);
  }

  function accessibleName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    }
    return element.getAttribute("aria-label")
      ?? element.getAttribute("alt")
      ?? element.getAttribute("title")
      ?? null;
  }

  function snapshot(element) {
    const rect = element.getBoundingClientRect();
    const markup = element.outerHTML.slice(0, MAX_MARKUP)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/\son\w+=(?:"[^"]*"|'[^']*')/gi, "");
    const width = Math.max(1, Math.min(Math.ceil(rect.width), 1_024));
    const height = Math.max(1, Math.min(Math.ceil(rect.height), 768));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${markup}</div></foreignObject></svg>`;
    try {
      const bytes = new TextEncoder().encode(svg);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return `data:image/svg+xml;base64,${btoa(binary)}`;
    } catch {
      return null;
    }
  }

  function finish() {
    document.documentElement.removeAttribute("data-aldunis-selecting");
    active = null;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.type !== "aldunis-preview:select-element") return;
    if (document.visibilityState !== "visible") {
      reply(event.source, event.origin, {
        type: "aldunis-preview:element-error",
        requestId: event.data.requestId,
        message: "The preview page is hidden.",
      });
      return;
    }
    active = { source: event.source, origin: event.origin, requestId: event.data.requestId };
    document.documentElement.setAttribute("data-aldunis-selecting", "");
  });

  document.addEventListener("click", (event) => {
    if (!active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = event.target instanceof Element ? event.target : null;
    if (!element || !element.isConnected || element.closest("iframe")) {
      reply(active.source, active.origin, {
        type: "aldunis-preview:element-error",
        requestId: active.requestId,
        message: "Cross-origin frames and stale elements cannot be referenced.",
      });
      finish();
      return;
    }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.visibility === "hidden" || style.display === "none" || rect.width === 0 || rect.height === 0) {
      reply(active.source, active.origin, {
        type: "aldunis-preview:element-error",
        requestId: active.requestId,
        message: "Hidden elements cannot be referenced.",
      });
      finish();
      return;
    }
    reply(active.source, active.origin, {
      type: "aldunis-preview:element-reference",
      requestId: active.requestId,
      selector: selectorFor(element),
      tag: element.localName,
      role: element.getAttribute("role"),
      name: accessibleName(element)?.trim().slice(0, 240) || null,
      text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) || null,
      screenshot: snapshot(element),
    });
    finish();
  }, true);

  document.addEventListener("visibilitychange", () => {
    if (active && document.visibilityState !== "visible") {
      reply(active.source, active.origin, {
        type: "aldunis-preview:element-error",
        requestId: active.requestId,
        message: "The preview page became hidden.",
      });
      finish();
    }
  });
})();
