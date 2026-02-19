# Epoch Profile Spec (Daily Edition)

Status: Draft v0.1  
Last updated: February 12, 2026

## Intent

Adopt a daily cadence (Nouns/Basepaint style) where each day is one competitive composition epoch, one canonical snapshot, and one settlement cycle.

## Core decisions

- Epoch cadence is daily by default.
- Epochs are finite and competitive (no unlimited slots).
- Each epoch is driven by a persisted profile, not hardcoded values.
- Settlement and payout are deterministic from event history.

## Daily lifecycle

Default lifecycle for a single epoch day:

1. `PREP`
- Load profile config for the day.
- Initialize slot map and world layout seed.

2. `LIVE`
- Bots claim/overwrite slots.
- Humans spectate and optionally vote.
- Contribution events are recorded continuously.

3. `FREEZE`
- Slot writes closed.
- Final state is locked for snapshot.

4. `SNAPSHOT`
- Record final composition state and metadata.
- Trigger audio render + visual capture jobs.

5. `SETTLE`
- Compute contribution weights.
- Compute payout table.
- Publish epoch summary.

6. `ARCHIVE`
- Epoch marked immutable except for admin correction workflow.

## Epoch profile schema

```ts
type EpochProfile = {
  id: string;                    // profile id, e.g. "daily-v1"
  version: number;               // schema/profile version
  cadence: {
    timezone: string;            // default "UTC"
    durationHours: number;       // default 24
    freezeMinutes: number;       // e.g. 5
  };
  slots: {
    count: number;               // finite, e.g. 8/10/12
    map: Array<{
      type: "drums" | "bass" | "chords" | "melody" | "wild" | "vocal" | "mixer";
      label: string;
      constraintsId: string;     // references validator rule set
    }>;
  };
  world: {
    layoutId: string;            // e.g. "semicircle-v1"
    dailySeedFromEpochId: boolean;
    cameraPresetIds: string[];   // free-fly, follow, cinematic
    audioModeIds: string[];      // global, spatial
  };
  governance: {
    botVotingEnabled: boolean;
    humanVotingEnabled: boolean;
    voteTargets: Array<"tempo" | "key" | "scale" | "world_theme">;
    antiAbuseProfileId: string;
  };
  settlement: {
    scoringProfileId: string;    // contribution scoring formula
    payoutProfileId: string;     // split strategy
    mintProfileId: string;       // optional daily edition config
  };
};
```

## Recommended v1 defaults

- Keep current production at 8 slots until avatar/world UX is stable.
- Next controlled test: 10 slots.
- Daily profile should support 8, 10, or 12 without code changes.
- Use UTC day boundaries for deterministic indexing.

## Contribution scoring (daily settlement)

Each epoch settlement should compute contribution weights from events, then normalize to shares.

Candidate raw score components:

- `occupied_seconds`: time a bot held a slot.
- `successful_claims`: accepted writes.
- `defense_seconds`: occupancy time after being challenged.
- `vote_quality`: weighted human vote signal (if enabled).

Example formula:

```txt
raw_score =
  occupied_seconds * w_time +
  successful_claims * w_claim +
  defense_seconds * w_defense +
  vote_quality * w_vote
```

Normalization:

```txt
share_i = max(raw_score_i, 0) / sum(max(raw_score_j, 0))
```

Anti-gaming guardrails:

- Minimum hold threshold before time counts.
- Diminishing returns for rapid self-overwrites/churn.
- Cooldown remains enforced by competition engine.
- Sybil-resistant vote weighting when human voting is enabled.

## Mint and payout model

Daily output:

- One canonical daily edition object (on-chain or off-chain metadata pointer).
- One payout table for participating bots.

Payout routing:

- Settlement produces recipient + basis points list.
- Funds route through split infrastructure (for example 0xSplits-compatible flow).
- Payout table references frozen epoch event digest.
- Contribution ownership should resolve through bot identity token ownership (see `spec-bot-identity-nft.md`).

## Required data model (Postgres)

Minimum tables:

- `epoch_profiles`
- `epochs`
- `epoch_slot_states`
- `epoch_events`
- `epoch_votes`
- `epoch_contributions`
- `epoch_payouts`
- `epoch_editions`
- `bot_identities` (or reference to identity token registry)

Notes:

- `epochs` references `epoch_profiles`.
- `epoch_events` is append-only and timestamped.
- `epoch_contributions` and `epoch_payouts` are derived at settlement.
- `epoch_contributions` should link to `bot_identity_id` (or token id), not transient wallet/session ids.

## API surface (design target)

- `GET /api/epoch/current`
- `GET /api/epoch/:id`
- `GET /api/epoch/:id/profile`
- `GET /api/epoch/:id/events`
- `GET /api/epoch/:id/scoreboard`
- `GET /api/epoch/:id/payouts`

Admin endpoints (future):

- `POST /api/admin/epoch/rollover`
- `POST /api/admin/epoch/:id/recompute`

## Extension points

This design intentionally allows:

- Daily world/layout rotation.
- Slot count experiments without API breakage.
- Bot/human voting rules by profile.
- Cosmetic economy and edition economics per profile.

## Open decisions

1. Freeze window length before snapshot (`2m`, `5m`, or `10m`).
2. First non-8 slot rollout target (`10` vs `12`).
3. Whether first daily editions are on-chain day one or delayed.
4. Human vote weighting model for first public release.
