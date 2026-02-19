# SynthMob Design Docs

This folder holds product and technical design documents.

## Fast Path

1. `status.md` - implemented behavior and active issues.
2. `architecture.md` - current stack, API surface, and data model.
3. `design-hub.md` - strategy and architectural principles.
4. `roadmap.md` - phased delivery path.

## Live System Docs

- `spec-agent-wayfinding.md` — wayfinding shadow-mode (Phase A live)
- `spec-avatar-generation.md` — Meshy avatar pipeline (Phase A live)

## Archived Specs

Early design specs moved to `docs/archive/` for reference. These describe systems that are not yet implemented:

- `vision.md` — high-level product direction
- `spec-visual-philosophy.md` — broadcast aesthetic direction
- `spec-viewer-broadcast-arena.md` — spectator presentation zones
- `spec-bot-identity-nft.md` — ERC-721 identity system
- `spec-epoch-profile.md` — daily cadence and settlement
- `spec-postgres-schema.md` — Postgres DDL for persistence layer
- `spec-contract-interface.md` — Solidity contract interfaces

## Doc Contract

- If behavior is live now, reflect it in `status.md`.
- Bot runtime contract lives in modular skills at `.claude/skills/synthmob*/SKILL.md`.
- Archived specs stay in `docs/archive/` until implementation begins.
