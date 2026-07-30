---
name: verify-code-change
description: >
  Verify Aldunis Code UI, provider adapter, permission, local-data, contract,
  packaging, documentation, or workflow changes with proportionate deterministic
  evidence. Use after implementation and before structured autoreview or
  shipment.
---

# Verify Code Change

Run narrow checks first, then expand according to risk. This skill is
**deterministic evidence** (tests, builds, surface checks). It is not a
substitute for structured `autoreview` — delivery skills run the global
autoreview helper after this skill succeeds.

## Procedure

1. Inspect status and the full diff. Classify every changed path and preserve
   unrelated work.
2. Run `npm run check` and `npm run build` for application changes. Exercise
   changed interactions at desktop and narrow widths, with keyboard navigation
   and reduced motion where relevant.
3. Add evidence by surface:
   - provider adapter: fixtures for events, cancellation, failure, and unknowns;
   - permissions: deny, allow-once, cancellation, scope, redaction, and replay;
   - filesystem: canonical paths, root escape, symlinks, deletion, and races;
   - local persistence: fresh, upgrade, corruption, retention, and recovery;
   - product clients: version drift, timeout, auth failure, and stale data;
   - packaging: clean install, loopback bind, startup, update, and rollback.
4. Validate changed repository skills with `quick_validate.py` when that helper
   exists for the changed skill.
5. Scan changed paths for credentials, transcripts, customer code, local
   databases, absolute private paths, and unredacted logs.

## After verify (ship closeout)

When preparing a commit or PR, the caller must still run structured autoreview
via the **global** helper (do not vendor it into this repo):

```bash
export AUTOREVIEW="$HOME/.grok/skills/autoreview/scripts/autoreview"
# fallbacks: $HOME/.agents/... or $HOME/.claude/...
"$AUTOREVIEW" --mode local   # or --mode branch / --mode commit as appropriate
```

See `deliver-ready-issue`. Do not report delivery as complete with only
deterministic verify.

## Output

Report every command and result, behavior covered, skipped checks and reasons,
failures, and residual uncertainty. Never say all checks passed when any
applicable check was not run. State whether autoreview still remains before
commit.
