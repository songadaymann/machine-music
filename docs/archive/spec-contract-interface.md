# Contract Interface Spec (Minimal)

Status: Draft v0.1  
Last updated: February 12, 2026

## Intent

Define the smallest on-chain interface required to support:

- One 1/1 identity NFT per bot identity
- Transferable ownership semantics
- Updatable metadata pointers for avatar/stats snapshots

## Contract topology

Minimal topology:

1. `BotIdentityNFT` (ERC-721)
- Canonical ownership (`ownerOf(tokenId)`).
- Mint on first avatar generation.

2. `BotIdentityRegistry` (pointer registry)
- Stores lightweight pointers and bot identity hash linkage.
- Emits events for indexers and backend sync.

This keeps NFT ownership standard and metadata mutation explicit.

## Solidity interfaces (design draft)

```solidity
pragma solidity ^0.8.24;

interface IBotIdentityNFT {
    event IdentityMinted(
        uint256 indexed tokenId,
        bytes32 indexed botIdentityHash,
        address indexed to
    );

    function ownerOf(uint256 tokenId) external view returns (address);
    function tokenURI(uint256 tokenId) external view returns (string memory);

    // Mint exactly one identity token per botIdentityHash.
    function mintIdentity(
        address to,
        bytes32 botIdentityHash,
        string calldata initialTokenURI
    ) external returns (uint256 tokenId);

    function exists(uint256 tokenId) external view returns (bool);
    function botIdentityHashOf(uint256 tokenId) external view returns (bytes32);
}

interface IBotIdentityRegistry {
    event BotMetadataURIUpdated(uint256 indexed tokenId, string metadataURI);
    event ActiveAvatarURIUpdated(uint256 indexed tokenId, string avatarURI);
    event StatsSnapshotURIUpdated(uint256 indexed tokenId, string statsURI);
    event AvatarManifestURIUpdated(uint256 indexed tokenId, string manifestURI);

    function setMetadataURI(uint256 tokenId, string calldata metadataURI) external;
    function setActiveAvatarURI(uint256 tokenId, string calldata avatarURI) external;
    function setStatsSnapshotURI(uint256 tokenId, string calldata statsURI) external;
    function setAvatarManifestURI(uint256 tokenId, string calldata manifestURI) external;

    function metadataURI(uint256 tokenId) external view returns (string memory);
    function activeAvatarURI(uint256 tokenId) external view returns (string memory);
    function statsSnapshotURI(uint256 tokenId) external view returns (string memory);
    function avatarManifestURI(uint256 tokenId) external view returns (string memory);
}
```

## Access control model

Recommended permissions:

- `mintIdentity`: app minter role only.
- Pointer updates:
  - app service role, or
  - token owner with policy checks.

Practical v1:

- Service role updates pointers after moderation + storage pipeline.
- Owner-triggered actions happen via app backend and are validated against `ownerOf`.

## Invariants

1. One identity token per `botIdentityHash`.
2. `ownerOf(tokenId)` is the only canonical ownership source.
3. Off-chain DB ownership cache must reconcile from on-chain transfers.
4. Pointer updates are append-observable via events.

## Indexer requirements

Indexer should consume:

- ERC-721 `Transfer` events from `BotIdentityNFT`
- All registry pointer update events

Indexer outputs:

- Current owner table
- Pointer history table
- Audit trail for metadata transitions

## Mapping to Postgres

Suggested mapping:

- `bot_identities.contract_address` + `token_id` from mint event
- `bot_identity_owners` updated from transfer events
- `bot_stats_snapshots.snapshot_uri` from `StatsSnapshotURIUpdated`
- `bot_avatars` + loadout updates mirrored from backend pipeline and pointer events

## Chain and deployment notes

- Start on one chain with low fee and strong tooling support.
- Keep interface chain-agnostic by keying on `(chain_id, contract_address, token_id)`.
- If multi-chain later, preserve same interface and indexer contract.

## Open decisions

1. Should `tokenURI` be mutable or fixed with registry pointers only?
2. Should owner be allowed direct pointer updates, or backend-only?
3. Should identity hash be `bytes32(keccak256(slug))` or random UUID hash?
4. Should minting be paid on-chain by user or sponsored by app backend?
