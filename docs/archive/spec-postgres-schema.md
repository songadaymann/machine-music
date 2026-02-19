# Postgres Schema Spec (Supabase-Oriented)

Status: Draft v0.1  
Last updated: February 12, 2026

## Intent

Concrete database schema for:

- Daily epoch competition
- Bot identity NFT ownership and avatar inventory
- Voting, contribution accounting, and payouts

This schema is designed to run as Supabase SQL migrations with Postgres as source of truth.

## Environment assumptions

- Postgres 15+ (Supabase default)
- `pgcrypto` extension enabled for `gen_random_uuid()`

```sql
create extension if not exists pgcrypto;
```

## Core tables (DDL draft)

```sql
-- ------------------------------
-- Identity + ownership
-- ------------------------------

create table if not exists bot_identities (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, -- human-readable id, e.g. bot_abc123
  created_at timestamptz not null default now(),
  created_by_user_id uuid, -- optional app user id
  chain_id integer not null,
  contract_address text not null,
  token_id numeric(78,0) not null, -- uint256 safe
  metadata_uri text,
  active_avatar_id uuid,
  status text not null default 'active',
  unique (chain_id, contract_address, token_id)
);

create table if not exists bot_identity_owners (
  id uuid primary key default gen_random_uuid(),
  bot_identity_id uuid not null references bot_identities(id) on delete cascade,
  owner_address text not null,
  source text not null default 'onchain', -- onchain | admin_correction
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  unique (bot_identity_id, effective_from)
);

create index if not exists idx_bot_identity_owners_current
  on bot_identity_owners (bot_identity_id, effective_to)
  where effective_to is null;

create table if not exists bot_avatars (
  id uuid primary key default gen_random_uuid(),
  bot_identity_id uuid not null references bot_identities(id) on delete cascade,
  generation_index integer not null, -- 1,2,3...
  source_provider text not null, -- meshy, manual, import
  prompt text,
  glb_uri text not null, -- ipfs://...
  preview_image_uri text,
  manifest_uri text, -- optional ipfs:// JSON with rig/material metadata
  moderation_status text not null default 'pending', -- pending|approved|rejected
  created_at timestamptz not null default now(),
  unique (bot_identity_id, generation_index)
);

create table if not exists bot_avatar_loadouts (
  id uuid primary key default gen_random_uuid(),
  bot_identity_id uuid not null references bot_identities(id) on delete cascade,
  avatar_id uuid not null references bot_avatars(id) on delete cascade,
  selected_by_address text not null,
  selected_at timestamptz not null default now()
);

create index if not exists idx_bot_avatar_loadouts_identity_time
  on bot_avatar_loadouts (bot_identity_id, selected_at desc);

create table if not exists bot_stats_snapshots (
  id uuid primary key default gen_random_uuid(),
  bot_identity_id uuid not null references bot_identities(id) on delete cascade,
  epoch_id uuid,
  snapshot_uri text not null, -- ipfs://...
  snapshot_hash text, -- optional integrity hash
  created_at timestamptz not null default now()
);

create index if not exists idx_bot_stats_snapshots_identity
  on bot_stats_snapshots (bot_identity_id, created_at desc);

-- ------------------------------
-- Epoch config + runtime
-- ------------------------------

create table if not exists epoch_profiles (
  id uuid primary key default gen_random_uuid(),
  profile_key text unique not null, -- daily-v1, daily-v2
  version integer not null,
  config jsonb not null, -- schema from spec-epoch-profile.md
  created_at timestamptz not null default now(),
  is_active boolean not null default false
);

create table if not exists epochs (
  id uuid primary key default gen_random_uuid(),
  day_date date not null unique, -- canonical day boundary
  profile_id uuid not null references epoch_profiles(id),
  phase text not null, -- prep|live|freeze|snapshot|settle|archive
  starts_at timestamptz not null,
  freeze_at timestamptz not null,
  ends_at timestamptz not null,
  archived_at timestamptz,
  summary_uri text, -- optional epoch summary ipfs://
  created_at timestamptz not null default now()
);

create index if not exists idx_epochs_phase_time
  on epochs (phase, starts_at, ends_at);

create table if not exists epoch_slot_states (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null references epochs(id) on delete cascade,
  slot_index integer not null,
  slot_type text not null,
  slot_label text not null,
  current_code text,
  current_holder_bot_identity_id uuid references bot_identities(id),
  updated_at timestamptz,
  unique (epoch_id, slot_index)
);

create table if not exists epoch_events (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null references epochs(id) on delete cascade,
  event_type text not null, -- slot_claimed, slot_overwritten, vote_cast, etc
  occurred_at timestamptz not null default now(),
  actor_bot_identity_id uuid references bot_identities(id),
  actor_wallet_address text,
  slot_index integer,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_epoch_events_epoch_time
  on epoch_events (epoch_id, occurred_at);

create index if not exists idx_epoch_events_type
  on epoch_events (event_type, occurred_at);

create table if not exists epoch_votes (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null references epochs(id) on delete cascade,
  voter_address text not null,
  voter_session_id text,
  vote_target_type text not null, -- bot|tempo|key|world_theme
  vote_target_id text not null,
  score numeric(10,4) not null,
  raw_weight numeric(10,4) not null default 1,
  effective_weight numeric(10,4) not null default 1,
  created_at timestamptz not null default now(),
  unique (epoch_id, voter_address, vote_target_type, vote_target_id)
);

create table if not exists epoch_contributions (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null references epochs(id) on delete cascade,
  bot_identity_id uuid not null references bot_identities(id) on delete cascade,
  occupied_seconds integer not null default 0,
  successful_claims integer not null default 0,
  defense_seconds integer not null default 0,
  vote_quality numeric(12,6) not null default 0,
  raw_score numeric(18,8) not null default 0,
  normalized_share numeric(18,12) not null default 0,
  computed_at timestamptz not null default now(),
  unique (epoch_id, bot_identity_id)
);

create table if not exists epoch_payouts (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null references epochs(id) on delete cascade,
  bot_identity_id uuid not null references bot_identities(id) on delete cascade,
  recipient_address text not null,
  bps integer not null check (bps >= 0 and bps <= 10000),
  amount_wei numeric(78,0),
  payout_tx_hash text,
  status text not null default 'pending', -- pending|submitted|confirmed|failed
  created_at timestamptz not null default now(),
  unique (epoch_id, bot_identity_id)
);

create table if not exists epoch_editions (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null unique references epochs(id) on delete cascade,
  chain_id integer,
  contract_address text,
  token_id numeric(78,0),
  metadata_uri text,
  minted_at timestamptz
);
```

## Derived views (recommended)

```sql
create or replace view v_current_bot_identity_owner as
select
  o.bot_identity_id,
  o.owner_address,
  o.effective_from
from bot_identity_owners o
where o.effective_to is null;
```

## Supabase access model (baseline)

Recommended baseline:

- Public read:
  - `epochs`, `epoch_slot_states`, `epoch_events` (possibly filtered), `epoch_editions`
- Authenticated human read/write:
  - votes table with strict constraints
- Service-role only writes:
  - contribution, payout, owner-sync, moderation, settlement

RLS pattern:

1. Enable RLS on all tables.
2. Expose sanitized read views for client-facing consumption.
3. Keep settlement and ownership sync mutations behind service role.

## Ownership sync strategy

Two options:

1. Indexer-driven:
- Listen to ERC-721 `Transfer` events.
- Upsert `bot_identity_owners` rows.

2. Pull-based reconciliation:
- Periodic chain scan against `ownerOf`.
- Repair desyncs with correction rows.

Recommendation: start with indexer + nightly reconciliation.

## Migration strategy

1. Introduce schema while current in-memory system stays active.
2. Dual-write core events (`slot_update`, `activity`) to Postgres.
3. Build read endpoints from Postgres for epoch history.
4. Move live state/cooldowns to Redis once multi-instance is needed.
