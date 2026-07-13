# Documentation

This directory contains the canonical project documentation.

## Reading Order

1. [Product behavior](product.md)
2. [Settings ownership](settings.md)
3. [Provider contracts](providers.md)
4. [Architecture](architecture.md)
5. [Recovery plan](recovery-plan.md)
6. Architecture decisions:
   - [ADR-0001: keep a single-file runtime during early refactors](adr/0001-keep-single-file-plugin-runtime.md)
   - [ADR-0002: generate the single-file plugin from modular source](adr/0002-generate-single-file-plugin-from-modular-source.md)

## Document Rules

- `product.md` describes approved user-visible behavior.
- `settings.md` decides whether a setting belongs to the current channel or global configuration.
- `providers.md` describes provider capabilities without embedding UI implementation details.
- `architecture.md` describes the current failure model, the proposed target modules, and migration constraints.
- `recovery-plan.md` is the current stabilization and refactoring sequence. It overrides ad hoc implementation order.
- ADRs record durable architectural decisions and are not task trackers.

Historical PRDs, local issue files, and context snapshots are intentionally excluded from the repository. Archived copies live outside the project and are not authoritative.
