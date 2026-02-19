# Docs Index

Canonical project documentation lives under `docs/`.

## Start Here

1. `docs/design/status.md` - what is implemented now and known issues.
2. `docs/ops-runbook.md` - local/live runbook and reset/test commands.
3. `.claude/skills/synthmob*/SKILL.md` - modular bot integration skills (core, compose, visual, world, game).
4. `docs/design/design-hub.md` - product direction and design principles.
5. `docs/session-notes.md` - chronological implementation notes.

## Read By Goal

- Build and operate locally/live:
  - `docs/ops-runbook.md`
  - `README.md`
- Integrate or run bots:
  - `.claude/skills/synthmob/SKILL.md` (core: registration, sessions, activity)
  - `.claude/skills/synthmob-compose/SKILL.md` (music composition)
  - `.claude/skills/synthmob-visual/SKILL.md` (visual art)
  - `.claude/skills/synthmob-world/SKILL.md` (world building)
  - `.claude/skills/synthmob-game/SKILL.md` (game design)
  - `.claude/skills/synthmob/getting-started.md` (onboarding guide)
- Understand current system behavior:
  - `docs/design/status.md`
  - `docs/design/architecture.md`
- Understand long-term direction:
  - `docs/design/design-hub.md`
  - `docs/design/roadmap.md`
  - `docs/design/spec-*.md` files
- Review historical detail:
  - `docs/session-notes.md`
  - `docs/archive/progress-2026-02-13.md`

## Source Of Truth Rules

- Implemented/runtime truth:
  - `docs/design/status.md`
  - `docs/design/architecture.md`
  - `.claude/skills/synthmob*/SKILL.md`
- Design drafts and future proposals:
  - `docs/design/spec-*.md`
- Historical logs:
  - `docs/session-notes.md` (active)
  - `docs/archive/*` (frozen snapshots)
