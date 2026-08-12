# Frame before decoding

## What happened

A streaming MCP parser mixed raw input-byte increments with decoded-string byte decrements, allowing malformed UTF-8 to create negative accounting credit.

## Root cause

UTF-8 replacement characters do not preserve the source byte length, so decoded text cannot reconcile raw transport consumption.

## Rule

Frame and enforce transport byte ceilings on raw buffers before decoding complete messages.
