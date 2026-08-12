# Shared browser ownership

- Status: Accepted
- Date: 2026-08-02

## Context

The floating provider-observation view is intentionally read-only: it can show
an inline provider frame but cannot attach to a provider filesystem path or
control a provider-owned browser. T3 Code uses a different model: the desktop
application owns one browser session, the provider uses brokered browser tools,
and the operator sees the same browser surface and its picture-in-picture
mirror.

## Decision

Option A: Aldunis-owned shared browser. Aldunis creates one isolated, persistent
Electron browser partition per conversation, exposes bounded loopback-only
browser tools through a host broker, and renders that same session in the
desktop workspace and picture-in-picture window. Browser control stays disabled
until the operator explicitly enables it for that session; human input advances
the control epoch and stale agent actions fail closed. Provider-side MCP broker
responses stream within a 2 MiB ceiling and are cancelled when they exceed it,
so the bound applies before the complete response is retained or parsed.

Main tradeoff: this adds a desktop bridge, browser-session state, provider MCP
configuration, and a new explicit control authority, but it makes the agent and
operator observe the same page.

Option B: provider-owned observation only. Each provider remains responsible
for its own browser and Aldunis accepts only bounded inline frames for display.

Main tradeoff: it preserves the smallest trust boundary, but Aldunis cannot
guarantee that the page shown is the page the provider is controlling and cannot
offer shared human takeover.

Recommendation: choose Option A for the desktop product while retaining Option
B as the compatibility path for providers that do not expose the reviewed
browser MCP contract.

## Consequences

- The first shared-browser release is loopback-only; public navigation,
  arbitrary Chrome/CDP attachment, downloads, clipboard, credentials, and
  unrestricted page evaluation remain unavailable.
- Browser snapshots and action results are transient provider context. Aldunis
  does not add screenshots, visible page text, cookies, or browser actions to
  local conversation history.
- The browser control rule is session-scoped and disappears when the session is
  closed. It is not a global provider permission.
- Codex and reviewed ACP adapters receive the browser MCP server only when the
  adapter advertises the reviewed `browserAutomation` capability.
