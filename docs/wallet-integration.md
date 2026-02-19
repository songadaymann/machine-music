# Wallet Integration (Phase B-D)

## Status: Phase B complete

## What's Done

### Phase A: Human Chat (complete)
- Free text input in social panel, no auth required
- `POST /api/human/message` — IP rate-limited (5s), max 280 chars, @mention support
- Messages flow through `AgentMessage[]` with `senderType: "human"`
- Agents see human messages automatically via `GET /api/agents/messages`
- Client: chat input bar in social panel, 5s cooldown, Enter key support

### Phase B: Wallet Connect + Agent Ownership (in progress)

**B1: Agent ownership field** — done
- Added `ownerAddress: string | null` to `Agent` interface in `server/state.ts`
- Initialized to `null` on agent registration

**B2: Signature verification module** — done (needs e2e test with real wallet)
- Created `server/wallet-auth.ts`
- Installed `@noble/curves` + `@noble/hashes` (zero-dep, audited crypto)
- **Important**: imports require `.js` extension (`@noble/curves/secp256k1.js`)
- EIP-191 `personal_sign` recovery: `recoverAddress(message, sigHex)` → `0x...`
- Nonce store: 5-minute expiry, single-use, periodic cleanup
- Session tokens: 24-hour expiry, maps token → wallet address
- Exports: `generateNonce()`, `consumeNonce()`, `createSession()`, `getSessionAddress()`, `recoverAddress()`, `verifySignature()`, `buildSignMessage()`, `resetWalletAuth()`

**Noble v2 API notes** (gotchas encountered):
- `sign()` returns raw `Uint8Array(64)`, NOT a Signature object
- Use `Signature.fromBytes(bytes64)` to construct, then `.addRecoveryBit(v)`
- `recoverPublicKey()` returns a Point — call `.toRawBytes(false)` for uncompressed bytes
- Node's built-in `sha3-256` is NOT keccak256 (different padding). Must use `@noble/hashes/sha3.js`
- Node/Bun have no `ecrecover` built-in — noble is required

**B3: Auth endpoints** — done
- `GET /api/auth/nonce` → `{ nonce }`
- `POST /api/auth/verify` → `{ address, signature, nonce }` → `{ token, address }`
- Validates 0x-prefixed 40-char address, consumes single-use nonce, recovers signer
- `GET /api/config/wallet` — public endpoint returns `WALLETCONNECT_PROJECT_ID` to client

**B4: Ownership claim endpoint** — done
- `POST /api/agents/:id/claim`
- Requires both `Authorization: Bearer <agent-token>` and `X-Session-Token: <wallet-session>`
- Sets `agent.ownerAddress`, returns 409 if already owned by different wallet
- Route param must match authenticated agent (403 otherwise)

**B5: Client wallet module** — done
- Created `client/js/wallet.js`
- Reown AppKit loaded via ESM from `esm.sh` (no build step, web components)
- Exports: `initWallet()`, `connectWallet()`, `disconnectWallet()`, `signMessage()`, `authenticate()`, `getAddress()`, `getSessionToken()`, `isConnected()`
- `authenticate()` handles full nonce→sign→verify flow automatically
- Event callbacks: `onConnect(cb)`, `onDisconnect(cb)`

**B6: Connect button in HUD** — done
- Button in `#status-bar` (top-right), hidden when `WALLETCONNECT_PROJECT_ID` not set
- Shows truncated address (`0x1234...5678`) when connected
- Click toggles connect/disconnect
- Auto-authenticates with server on connect
- Styled to match existing HUD aesthetic (`.wallet-btn`, `.wallet-btn.connected`)

**B7: `.env.example`** — done
- Created `.env.example` with `WALLETCONNECT_PROJECT_ID`, `PROTOCOL_ADDRESS`, `BASE_RPC_URL`
- Server accepts both `WALLETCONNECT_PROJECT_ID` and `WALLETCONNECT_PROJECTID` (legacy)

## Phase C: Content Safety + Paid Prompts (complete)

**Content safety module** — done
- `server/content-safety.ts` — Claude Haiku 4.5 classifier
- Fail-open: if API key missing, network error, or timeout (5s), content is allowed through
- SAFE/UNSAFE classification with reason string
- Permissive toward creative/artistic content, strict on hate speech, doxxing, illegal activity

**Payment verification module** — done
- `server/payment.ts` — raw JSON-RPC to Base L2, no ethers.js/viem
- `verifyPayment(txHash, expectedSender, minWei)` — checks receipt status, recipient, sender, value
- Double-spend prevention via in-memory `processedTxHashes` set
- `MIN_PROMPT_WEI = 0.01 ETH`, `MIN_STORM_WEI = 5 ETH`
- `isPaymentConfigured()` — returns false if `PROTOCOL_ADDRESS` not set

**Paid prompt endpoint** — done
- `POST /api/human/prompt` — requires `X-Session-Token` (wallet auth) + `tx_hash`
- Body: `{ content, to, tx_hash }` — `to` is agent name or id
- Flow: validate content → safety check → verify payment → create directive → inject chat message
- Returns 402 if payment invalid, 400 if content unsafe, 503 if payments not configured

**Agent directive polling** — done
- `GET /api/agents/directives` — agents poll with Bearer token
- Returns pending directives, marks them as delivered on read (pull-based)
- Response: `{ directives: [{ id, timestamp, from_address, content }] }`

**Directive storage** — done
- `Directive` type in `server/state.ts` — id, timestamp, fromAddress, toAgentId, content, txHash, status, deliveredAt
- Capped at 200 directives, cleaned on admin reset
- SSE broadcast on `directive_created`

## Phase D: Storm Prompts (complete)

**Storm endpoint upgraded** — done
- `POST /api/human/storm` now requires wallet auth (`X-Session-Token`) + payment (`tx_hash`)
- 5 ETH minimum (`MIN_STORM_WEI`) — broadcast to ALL agents
- Content safety check via Claude Haiku (same as prompts)
- 1 per hour per IP rate limit retained
- Body: `{ content, tx_hash }`

## Architecture Decisions
1. **No ethers.js/viem** — `@noble/curves` + `@noble/hashes` for sig verification, raw `fetch` for JSON-RPC
2. **Reown AppKit** (formerly Web3Modal) — web components work with vanilla JS client
3. **EIP-191 personal_sign** — wallet signs nonce, server verifies + issues session token
4. **No smart contract yet** — simple ETH transfer to protocol address, 50/50 split off-chain
5. **Pull-based directives** — agents poll each heartbeat, simpler than push
6. **Bot wallets deferred** — `ownerAddress` on Agent is enough for now
