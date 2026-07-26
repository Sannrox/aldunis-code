# OpenCode as a reviewed declarative ACP adapter

- Status: Accepted
- Date: 2026-07-26
- Issue: #31

## Context

OpenCode speaks the Agent Client Protocol via `opencode acp` (stdio JSON-RPC).
Aldunis Code already runs third-party ACP providers through versioned,
digest-pinned declarative adapter packages (Kiro CLI, Grok Build CLI). OpenCode
fits that surface; it does not need a first-class non-ACP adapter like Shikigami.

## Decision

1. Ship a first-party **reviewed** adapter package `opencode-cli` that launches
   only `opencode` / `opencode.exe` with the fixed argument `acp`.
2. Reuse the existing ACP runtime, permission broker, session resume, and
   discovery/install UX. No new host protocol path.
3. OpenCode owns authentication, models, config, MCP, and native sessions.
   Aldunis does not proxy credentials or evaluate OpenCode policy.
4. The exact `opencode acp` launch is allowlisted in manifest validation the
   same way `kiro-cli acp` is (v1 otherwise forbids free-form positionals).
5. Existing Claude/Codex/Shikigami/declarative threads cannot silently resume
   as OpenCode; provider binding remains thread-scoped.

## Non-goals

Installing OpenCode for the user, auto-approving tools, Chisei-governed
routing, or treating OpenCode output as Chisei evidence.

## Consequences

Users install OpenCode themselves, then install the reviewed adapter from the
Provider adapters catalog. Readiness depends on PATH discovery of `opencode`.
