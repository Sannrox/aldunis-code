# Treat validation disappearance as change

## What happened

A bounded context-package read could fail the whole package when its final pathname check disappeared.

## Root cause

Descriptor validation handled identity mismatch but let `lstat` rejection escape instead of classifying the input as concurrently changed.

## Rule

Convert expected pathname disappearance during final stable-file validation into the subsystem's changed-input result.
