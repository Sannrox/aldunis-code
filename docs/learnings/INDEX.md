# Engineering learnings

| Learning                                                                                   | Area             | Summary                                                                           |
| ------------------------------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------- |
| [frame-before-decoding.md](frame-before-decoding.md)                                       | Provider bridges | Enforce byte ceilings on raw framing bytes before UTF-8 decoding.                 |
| [open-before-type-check-nonblocking.md](open-before-type-check-nonblocking.md)             | Filesystem reads | Use nonblocking, no-follow admission when type checks follow descriptor opening.  |
| [treat-validation-disappearance-as-change.md](treat-validation-disappearance-as-change.md) | Filesystem reads | Treat final-check disappearance as concurrent change, not a request-wide failure. |
