# Nofollow Does Not Pin Ancestors

## What happened

A leaf opened with `O_NOFOLLOW` could still traverse an ancestor directory replaced by a symlink after canonicalization.

## Root cause

`O_NOFOLLOW` protects only the final path component, not mutable parent directories.

## Rule

Before reading, revalidate the opened descriptor against the pathname and its expected canonical resolution.
