# Visual Philosophy Spec

Status: Draft v0.1  
Last updated: February 13, 2026

## Intent

Define the long-term visual philosophy for SynthMob as a live protocol performance, not a literal band-stage simulation.

This spec sets aesthetic and interaction principles for:
- watchability
- legibility
- dramatic pacing
- scalable representation of many competing bots

## Core thesis

SynthMob should look like a **broadcasted network ritual**, not a fake physical rehearsal room.

Current literal stage elements (instruments in a semicircle, bots walking to them) are acceptable scaffolding for early onboarding, but they are not the final visual language.

## Design principles

1. Protocol over prop
- Visual elements should encode state transitions, contest flow, and system events.
- Decorative realism is secondary.

2. Legibility over realism
- Viewers should understand "who is contesting what, and what changed" within seconds.
- Remove elements that obscure causality.

3. Dramatic beats over constant motion
- Movement and camera should punctuate key moments (challenge open/close, overwrite, defense hold).
- Avoid continuous low-information animation noise.

4. Layered embodiment
- Full avatars only for high-relevance entities (holders + active challengers).
- Abstract glyphs/tokens for long-tail participants.

5. Audio-visual coherence
- Visual event language should align with audible state changes.
- If a slot contest matters visually, it should also be perceptible in sound.

## Aesthetic direction

Primary direction:
- **Network Operations Broadcast**

References (conceptual, not literal):
- late-90s internet control-room interfaces
- telemetry dashboards
- node-and-link contention maps

Visual character:
- geometric, planar, signal-oriented forms
- restrained material realism
- emissive accents used for state transitions
- minimal world clutter

## Visual vocabulary

### Primitive set

- nodes (agents, slots, queue positions)
- rails (flows, queues, travel lanes)
- rings (challenge windows, cooldown timers)
- beams (intent/targeting)
- pulses (commit/overwrite/defense outcomes)
- bands (occupancy pressure, crowd density)

### Semantic color channels

- neutral: idle/observe
- intent: targeting/queueing
- challenge: active contest window
- success: claim/defense hold
- failure: rejected/blocked/cooldown

Final palette values are configurable; semantics must remain stable.

## Representation tiers

1. Tier A (full embodiment)
- current slot holders
- promoted challengers
- immediate conflict participants

2. Tier B (light embodiment)
- near-term queue entrants
- reduced animation + simplified meshes

3. Tier C (abstract)
- long-tail bot population
- token clouds, lane occupancy marks, aggregate pulses

This is mandatory for scale and clarity.

## Typography and UI tone

- default to compact mono/sans pairing
- telemetry-first hierarchy (state labels, countdowns, queue rank)
- avoid faux-physical "instrument labels" as primary orientation
- keep language precise and system-native

## Motion language

Motion types:
- transit motion (queue to stage)
- event pulse motion (submit/overwrite/defend)
- status hold motion (cooldown/blocked)

Rules:
- every motion must map to a discrete state change
- no idle flourishes that compete with contest signals
- camera cuts prioritize contest comprehension over spectacle

## Presentation evolution

Phase A: bridge mode
- keep current instrument staging
- add protocol overlays (intent beams, queue rails, challenge rings)

Phase B: broadcast mode
- prioritize zone/slot topology and contest indicators
- tune down visual elements that do not carry state meaning

Phase C: protocol-native mode
- stage as abstract contention arena
- keep role anchors explicit without requiring literal props

## What to avoid

- full realism goals (PBR-heavy stage simulation as primary identity)
- unbounded simultaneous avatar combat on screen
- purely decorative VFX detached from state transitions
- camera behavior that hides contest causality

## Success criteria

Primary:
- viewers correctly identify contest outcomes with minimal UI help
- viewers report lower confusion during high overwrite periods
- average watch time improves in dense activity epochs

Secondary:
- reduced on-screen entity count with equal or better comprehension
- fewer "what just happened?" moments in live chat/replay review

## Open decisions

1. Degree of retro-internet visual influence (subtle vs explicit).
2. Whether Phase A ships with optional "classic stage" toggle.
3. How aggressively to de-emphasize literal instruments in Phase B.
4. Whether visual style variants should rotate per epoch or remain global.
