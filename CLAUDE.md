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

## Toolchain — WSL setup that actually works

The Solana/Anchor toolchain does not run natively on Windows here; everything below
runs inside WSL. **This exact combination is what built successfully — do not
downgrade any part of it** (see "Why these versions" below).

| Component | Version |
|---|---|
| WSL distro | Ubuntu (WSL2) |
| Host Rust | stable (1.98.0 at time of setup) |
| Solana CLI | Agave 4.2.1 (`cargo-build-sbf` 4.1.0, platform-tools **v1.54**) |
| Anchor CLI | 0.31.1 (via `avm`) |
| Node (in WSL) | 20.x + yarn |

One-time setup, from an elevated PowerShell then inside WSL:

```powershell
wsl --install -d Ubuntu --no-launch     # WSL2 + Ubuntu, no interactive account prompt
```

```bash
# --- run as root inside: wsl -d Ubuntu -u root ---
apt-get update
apt-get install -y build-essential pkg-config libssl-dev libudev-dev zlib1g-dev \
    llvm clang cmake make libprotobuf-dev protobuf-compiler curl git bzip2 ca-certificates

# Host Rust (stable; must support edition2024)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
export PATH="$HOME/.cargo/bin:$PATH"

# Solana CLI - use the *stable* channel, not a pinned 1.18/2.1 (see below)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Node + yarn (Anchor.toml's test script shells out to yarn)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
npm install -g yarn

# Anchor via avm
cargo install --git https://github.com/coral-xyz/anchor avm --tag v0.31.1 --locked --force
export PATH="$HOME/.avm/bin:$PATH"
avm install 0.31.1 && avm use 0.31.1

# Anchor.toml points provider.wallet at this; create it once
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json
```

Build and test (note the project path contains spaces — always quote it):

```bash
cd "/mnt/c/Users/Aaro Eskelinen/SOLANA WAGER konsepti"
anchor build
anchor test --skip-local-validator   # tests use bankrun in-process; no validator needed
```

`npm install` for the root test deps **must be run from inside WSL** — `solana-bankrun`
is a native NAPI module and the Windows binaries will not load under Linux.

### Why these versions (do not "simplify" this)
The original pairing (Anchor 0.30.1 + Solana 1.18.26 + Rust 1.79) **cannot build this
project today**, and a lot of time was burned discovering why:

1. With no `Cargo.lock` committed, Cargo resolved every transitive dep to its newest
   release. Dozens of those adopted **edition2024** during 2025, which Rust 1.79 cannot
   parse. Pinning them back one at a time does not converge — `blake3` → `digest` →
   `block-buffer`, then `proc-macro-crate` → `toml_edit` → `toml_datetime`, then
   `getrandom`, and so on.
2. Upgrading only the *host* Rust does not help: `cargo-build-sbf` uses the Rust bundled
   in **platform-tools**, and both Solana 1.18.26 (v1.43) and Agave 2.1.21 ship Rust
   1.79. Only platform-tools **v1.54** (Agave 4.x) is new enough.
3. Anchor 0.30.1 additionally cannot generate an IDL on a modern registry at all — its
   `anchor-syn` calls `proc_macro2::Span::source_file()`, an API since removed. The IDL
   build re-resolves under a separate cargo, so lockfile pins do not reach it. Anchor
   **0.31.1** fixes this.

A `Cargo.lock` is now committed. Keep it committed.

## Status of on-chain verification — ✅ GREEN
- `anchor build` passes. Produces `target/deploy/arena.so`, `target/idl/arena.json`
  (all four instructions incl. `cancel_match`, 10 errors), `target/types/arena.ts`.
- `anchor test --skip-deploy --skip-local-validator` — **7 passing, 0 failing.**
  Happy path, rake math, double-join rejected, bad-signature rejected, plus the three
  `cancel_match` tests (refund, non-authority rejected, already-started rejected).

Use `--skip-deploy --skip-local-validator`. Plain `anchor test` fails: `--skip-local-validator`
alone still tries to *deploy* to `127.0.0.1:8899`, and these tests need no validator —
bankrun runs an in-process SVM and loads `target/deploy/arena.so` directly.

### Test-suite gotchas (all cost real debugging time — don't reintroduce)
- **Never use `@solana/spl-token`'s action helpers** (`createMint`, `mintTo`,
  `createAssociatedTokenAccount`, `getAccount`) in these tests. They call
  `connection.sendTransaction`, and `BankrunProvider.connection` is a BanksClient shim,
  not a real `Connection`. Use the instruction builders plus the local `sendTx()` /
  `getTokenAccount()` helpers.
- **`settle_match` takes no `.signers([...])`.** It declares no `Signer` account — the
  server authorises via the ed25519 prelude instruction. Passing the server key there
  fails with `unknown signer`.
- **bankrun reuses one blockhash**, so re-sending an identical transaction is rejected
  as "already processed" before the program runs. The double-join test therefore
  resubmits with a different fee payer to make the transaction distinct.
- **Raw `banksClient` submissions bypass Anchor's error translation**, surfacing
  `custom program error: 0x…` instead of the variant name. `ArenaError` numbering starts
  at 6000 in declaration order (e.g. `AlreadyJoined` = 6003 = `0x1773`).
- `anchor-bankrun` 0.5.0 (its newest) declares a peer of `@coral-xyz/anchor@^0.30.0`
  while the program is on 0.31.1, so root installs need `npm install --legacy-peer-deps`.
  `BankrunProvider`'s API is unchanged across that gap.

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

## Deviation — Anchor upgraded 0.30.1 → 0.31.1
The plan assumed the program stayed on `anchor-lang` 0.30.1. It could not: 0.30.1's IDL
generator is broken against any current crate registry (reason 3 above), and the IDL is
required by `tests/arena.ts`. `programs/arena/Cargo.toml` now targets `anchor-lang` /
`anchor-spl` **0.31.1**, and the root `package.json` was bumped to `@coral-xyz/anchor`
**^0.31.1** so the TS client matches the 0.31 IDL format. `@solana/spl-token` and
`tweetnacl` were also added there — `tests/arena.ts` imports both but neither was
declared.

## Five pre-existing bugs the first compile exposed
The program had never been built, so none of these had ever surfaced. All are fixed:
1. `Cargo.toml` — `anchor-spl` feature was `associated-token`; the real name is
   `associated_token`. Dependency resolution failed outright.
2. `settle_match.rs` — `#[account(address = sysvar::instructions::ID)]` referenced an
   unimported `sysvar`; only the `ix_sysvar` alias is in scope.
3. `instructions/mod.rs` — re-exported only the Accounts structs, so the
   `__client_accounts_*` modules generated by `#[derive(Accounts)]` never reached the
   crate root where `#[program]` looks for them. Now uses glob re-exports.
4. `settle_match.rs` — six `E0502` borrow errors: `&mut match_account` was held across
   the CPI calls that need it borrowed immutably. Values are copied up front and the
   mutation deferred to the end.
5. `Cargo.toml` — missing the `[features]` block, including `idl-build`, which Anchor
   0.30+ requires.

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
  (on-chain ed25519 verified), `cancel_match` (ported, hardened). **Compiles** under the
  toolchain above; `arena.so` + IDL + types are generated.
- **Tests** (`tests/arena.ts`): 7 tests, all passing — happy path, rake math,
  double-join rejected, bad signature rejected, and three `cancel_match` tests (refund
  happy path, non-authority rejected, already-started rejected).
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
  - Program: from WSL, `anchor build && anchor test --skip-local-validator`
  - Game: from `OpenFrontIO/`, `npx tsc --noEmit` and `npm run lint`
  - Current `OpenFrontIO` tsc baseline is **2 pre-existing errors**
    (`arena/settler.ts` possibly-undefined, `GameServer.ts` null-assignability). Both
    are fixed by Stage 5. Any count above 2 means you introduced something.
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
