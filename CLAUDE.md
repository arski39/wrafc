# CLAUDE.md — Solana Wager Arena (OpenFrontIO + Anchor escrow)

## Project Overview
A skill-based wagering layer on top of **OpenFront.io**, a real-time multiplayer
territorial-conquest game. Players stake SPL tokens into an on-chain escrow, play a
normal OpenFront match, and the winner is paid out from escrow by a Solana program
that verifies a server ed25519 signature over the result.

Two components:
1. `programs/arena/` — Anchor program (escrow: `create_match`, `join_match`,
   `settle_match`, `cancel_match`). Tested by `tests/arena.ts` (bankrun).
2. `OpenFrontIO/` — the game itself, a **nested git repository with its own history
   and its own `CLAUDE.md`**. Read `OpenFrontIO/CLAUDE.md` before touching anything
   inside it. The wager integration lives in `OpenFrontIO/src/server/arena/` and
   `OpenFrontIO/src/client/arena/`.

> **History note:** this project previously had a bespoke agar.io-style engine in
> root-level `server/` and `client/`. That engine was **deleted** in favour of
> OpenFrontIO. Do not resurrect it. It is recoverable from git commit `d5c610a` if
> ever needed.

## ⛔ BLOCKER before any on-chain verification
**WSL toolchain install + `anchor build && anchor test` must pass, including the three
new `cancel_match` tests. No wager flow may be tested end-to-end until this completes.**

The Rust/Solana/Anchor toolchain is **not installed** on this machine (no `rustc`,
`cargo`, `rustup`, `solana`, `anchor`, `avm`; WSL has no distro). Until that is fixed:
- The Anchor program has **never been compiled** — there is no `target/` directory, so
  `tests/arena.ts`'s `import type { Arena } from "../target/types/arena"` cannot resolve.
- The `cancel_match` port and its tests (below) are **written but unverified**.
- TypeScript work proceeds gated on `tsc --noEmit` only.

## Hard Rules
- All wager logic lives in the Anchor program. **The server never holds user funds.**
  The server's keypair is the match `authority` and pays account rent — it never
  custodies stakes.
- `settle_match` **must** verify the server's ed25519 signature on-chain. It does this
  by reading the `Ed25519Program` instruction at **index 0** of the same transaction
  (`load_instruction_at_checked`) and recomputing
  `sha256(match_account.key() || winner || scores_as_u64_le)`. The signing side must
  produce **exactly** those bytes — see `tests/arena.ts`'s `buildSettleMessage()`, which
  is the reference implementation. Raw bytes; **not** JSON, not the game id string.
- Keep TypeScript strict. No `any` in new code except WebSocket message-parsing
  boundaries — type those with discriminated unions (OpenFrontIO uses Zod schemas in
  `src/core/Schemas.ts` for this).
- Do not add dependencies without stating why in the commit message.
- Never commit keypairs. `.env` and `*keypair*.json` are gitignored — keep it that way.
- When touching settlement math or account layout, add/update a bankrun test in the
  same change.

## ⚠️ Accepted v1 limitation — client-vote winner determination
**This is a deliberate, accepted risk, not an oversight.**

OpenFrontIO's simulation runs **on each client**, not on the server (see
`OpenFrontIO/CLAUDE.md` → "Simulation Flow"). The server only relays intents. At match
end, each client computes its own winner (`src/core/game/GameImpl.ts` `setWinner`) and
reports it; the server accepts a winner only once a **majority of unique-IP clients
agree** (`GameServer.handleWinner`, `VoteTally.ts`).

This means **the server does not independently verify who won** — it trusts client
consensus, then signs that result for on-chain payout. In a wagered match this is a
collusion surface: in a small or 1v1 lobby, colluding clients can satisfy the
"majority" trivially and cause a false payout.

This conflicts with the usual "never trust the client" posture and is accepted **for
v1 only**, to get the wager loop working end-to-end. Anyone hardening this later should
consider: requiring unanimity among wallet-verified paying players, or server-side
validation against the per-turn state hashes already exchanged for desync detection
(`GameServer.ts`). **Do not widen wagered matches to large public lobbies, or raise
stake limits, without revisiting this.**

## Deviation from the original plan — `cancel_match` port
The approved plan said to leave `programs/arena/` unmodified. That was based on a stale
assumption, and we deviated deliberately. Reason:

Two divergent copies of the Anchor program existed — one at the project root, one inside
`OpenFrontIO/programs/`. They were **not** the same program:
- **Root** (kept): `settle_match` performs real on-chain ed25519 verification. Had no
  refund path.
- **OpenFrontIO copy** (deleted): had a `cancel_match` refund path, but its
  `settle_match` performed **no signature verification at all** — just a
  `TODO (Phase 2, task 6)` and `let _ = standings;`. Any caller naming a valid winner
  could have triggered a payout.

Resolution: the root program is canonical (security is non-negotiable). `cancel_match`
was ported into it, **hardened** in the process — the OpenFrontIO original left `vault`
unconstrained, so the port adds `address = match_account.vault @ ArenaError::InvalidVault`
to match how `join_match`/`settle_match` pin the vault. The `Unauthorized` error variant
was added to `errors.rs` (root lacked it). The duplicate `OpenFrontIO/programs/`,
`OpenFrontIO/Anchor.toml`, `OpenFrontIO/Cargo.toml`, and the orphaned
`OpenFrontIO/tsconfig.test.json` were deleted.

This also explains a discrepancy you may notice in git history: `settler.ts`'s
JSON-style digest was never a bug against the *OpenFrontIO* program (whose header
documents exactly that format) — it is wrong only against the canonical root program,
which is what it must now match.

## Current State
- **Anchor program** (`programs/arena/`): all four instructions implemented —
  `create_match` (vault is a real PDA-owned ATA), `join_match`, `settle_match`
  (on-chain ed25519 verified), `cancel_match` (ported, hardened). **Never compiled** —
  see BLOCKER.
- **Tests** (`tests/arena.ts`): happy path, rake math, double-join rejected, bad
  signature rejected, plus three new `cancel_match` tests (refund happy path,
  non-authority rejected, already-started rejected). **Never run** — see BLOCKER.
- **OpenFrontIO wager integration**: partially built, largely unwired. Working:
  `arena/auth.ts` + `client/arena/walletAuth.ts` (SIWS-style wallet signature),
  `matchRegistry`, `walletRegistry`, and the wagered-join gate in `Worker.ts`.
  Stubbed/broken: `matchCreator.ts` (placeholder PDA, never called),
  `onchainJoin.ts` (returns undefined), `rpcClient.ts` (checks a tx signature, never
  reads `MatchAccount.players[]`), `settler.ts` (wrong digest format, never submits).
  `WagerLobby.ts` is fully built but never mounted and omits `walletSig`.
- **Dependencies**: `OpenFrontIO/package-lock.json` was out of sync with its
  `package.json` (arena scaffolding added `@solana/web3.js`/`tweetnacl` without locking
  them), so `npm ci` was impossible. Resolved with `npm install --ignore-scripts`.
  Use `npm run inst` from now on, per `OpenFrontIO/CLAUDE.md`.

## Task Queue — remaining work, in order
Each stage is gated on `npx tsc --noEmit` (from `OpenFrontIO/`) before moving on.

2. **`matchCreator.ts`** — real PDA/ATA derivation and a real `create_match` submission;
   wire it to a new creator-only `POST /api/game/:id/wager` endpoint in `Worker.ts`,
   called from `HostLobbyModal.ts` after `createLobby()`. Extend `GET /api/game/:id` to
   expose wager info. Scope wagered games to **private lobbies only** for v1.
3. **Client on-chain join** — implement `onchainJoin.ts`'s `join_match` submission; fix
   `WagerLobby.ts` to also call `signAuthMessage()` and emit `walletSig`; mount the
   wager step in `Main.ts`'s `handleJoinLobby()`; thread
   `{walletAddress, walletSig, onchainTxSig}` through `ClientGameRunner`'s `LobbyConfig`
   into `Transport.joinGame()`'s `ClientJoinMessage`.
4. **`rpcClient.ts`** — replace the tx-signature check with a real `MatchAccount`
   fetch + fixed-offset decode + `players[0..player_count]` scan.
5. **`settler.ts`** — fix the digest to `sha256(matchPDA || winner || scores_u64_le)`;
   rebuild standings from on-chain `players[]` order; build the Ed25519 instruction
   (port `buildEd25519InstructionData` from `tests/arena.ts`) at index 0 plus the
   `settle_match` instruction; submit. Add `TREASURY_TOKEN_ACCOUNT` and
   `ARENA_PROGRAM_ID` to `OpenFrontIO/example.env`.
6. **Dev-mode auth bypass** — `Worker.ts`'s wagered-join gate requires a `jti` claim
   with no dev bypass, while the on-chain check right beside it *does* bypass in dev.
   Local/anonymous dev sessions never have a `jti`, so the wagered path is currently
   untestable without the closed-source auth API. Add a symmetric dev bypass.

## Conventions
- Commits: conventional commits (`feat(arena):`, `fix(program):`, …).
- Inside `OpenFrontIO/`, mark every edit to a pre-existing upstream file with an
  `// [ARENA]` comment — see `OpenFrontIO/docs/upstream-map.md`. This keeps upstream
  merges tractable.
- Checks before declaring done:
  - Program: `anchor build && anchor test` (blocked — see BLOCKER)
  - Game: from `OpenFrontIO/`, `npx tsc --noEmit` and `npm run lint`
- The `run-openfront` skill in `OpenFrontIO/.claude/skills/` is written for headless
  Ubuntu + Playwright and does not apply directly on this Windows machine. Use the
  human path: `npm run dev`, then open `http://localhost:9000`.

## Environment Variables
`OpenFrontIO/.env` (add to `example.env` as they land):
- `SOLANA_RPC_URL` — RPC endpoint
- `SERVER_KEYPAIR_PATH` — server ed25519 keypair; **must be the same keypair** used as
  match `authority` in `create_match` and as signer in `settle_match`
- `ARENA_PROGRAM_ID` — deployed program id
- `TREASURY_TOKEN_ACCOUNT` — rake destination token account
- Existing OpenFront vars (`GAME_ENV`, `API_KEY`, `DOMAIN`, …) — see its `example.env`

**Ops requirement:** the server keypair needs a funded SOL balance to pay rent for each
match's `MatchAccount` and vault ATA. Use a devnet faucet for testing.
