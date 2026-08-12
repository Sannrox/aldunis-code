# Open Before Type Check Nonblocking

## What happened

A stable-file reader opened a worktree path before checking the descriptor type, so a FIFO replacement could block the scan.

## Root cause

Descriptor pinning moved regular-file validation after an ordinary blocking open.

## Rule

Use nonblocking, no-follow flags whenever descriptor opening must precede regular-file validation.
