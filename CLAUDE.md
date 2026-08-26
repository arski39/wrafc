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
  (all four instructions incl. `cancel_match`, **11** errors, and one `#[constant]`),
  `target/types/arena.ts`.
- `anchor test --skip-deploy --skip-local-validator` — **31 passing, 0 failing.**
  - `tests/arena.ts` (10): happy path, rake math, double-join rejected,
    bad-signature rejected, and the six `cancel_match` tests — refund,
    non-authority rejected, in-progress-before-timeout rejected,
    in-progress-after-timeout refunds, settle still works past the timeout,
    settled-match cancel rejected.
  - `tests/arenaProgram.ts` (21): pins the hand-rolled program bindings
    (`OpenFrontIO/src/core/arena/arenaProgram.ts`) — see below.

Use `--skip-deploy --skip-local-validator`. Plain `anchor test` fails: `--skip-local-validator`
alone still tries to *deploy* to `127.0.0.1:8899`, and these tests need no validator —
bankrun runs an in-process SVM and loads `target/deploy/arena.so` directly.

### `tests/arenaProgram.ts` — why there is no Anchor client
Arena instructions are built **byte by byte** rather than through `@coral-xyz/anchor`:
the same module ships to the browser for the client-side `join_match`, and Anchor's
coder is a large bundle for four instructions. The cost is constants that can silently
drift from the program, so that suite pins both ends:

1. every discriminator, field offset, account order and arg order is **diffed against
   the generated `target/idl/arena.json`**, and
2. the `create_match` and `join_match` instructions that would actually be sent are
   **executed against the real program in bankrun**, then the resulting account is read
   back through `decodeMatchAccount` — the same decoder the server uses — including its
   rejection paths (wrong owner, bad discriminator, short buffer, out-of-range
   `player_count`/`status`).

Either half alone is insufficient — (1) would pass against a stale IDL, (2) would pass on
a layout that merely round-trips. Keep both when adding an instruction.

**The discriminator trap this exists to catch:** Anchor 0.31 names instructions in
**snake_case** in the IDL; 0.30 used camelCase. The discriminator is
`sha256("global:" + name)[0..8]`, so hashing `createMatch` instead of `create_match`
yields eight entirely different bytes — a mistake nothing catches until the chain
rejects the transaction. `arenaProgram.ts` pins the values and the suite asserts both
that they match the IDL and that they are *not* the camelCase hash.

Note the root test imports across into `OpenFrontIO/` (which root `tsconfig.json`
excludes — `exclude` only filters the `include` globs, imported files still compile).
That works only because `arenaProgram.ts` imports nothing but `@solana/web3.js` and
`buffer`. **Keep it free of OpenFrontIO imports** or the root suite stops building, and
**free of Node built-ins** or the browser bundle breaks at runtime. `buffer` is the one
allowed exception: Node prefers its own builtin for that bare specifier while bundlers
resolve the npm package, so it works in both realms — unlike the bare `Buffer` global,
which type-checks via `@types/node` and is simply `undefined` in a browser.

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
- **Tests**: 31 passing on the program side (`tests/arena.ts` for behaviour,
  `tests/arenaProgram.ts` for the shared bindings, decoder and settlement), and
  3301 passing on the game side (`npm test` from `OpenFrontIO/`, including
  `tests/ArenaWalletAuth.test.ts`, `tests/server/ArenaStartGate.test.ts` and
  `tests/server/AppShellBranding.test.ts`).
- **OpenFrontIO wager integration**: the full stake loop is wired — host creates the
  escrow, every player (host included) stakes into it. Working: `arena/auth.ts` +
  `client/arena/walletAuth.ts` (SIWS-style wallet signature), `matchRegistry`,
  `walletRegistry`, the wagered-join gate in `Worker.ts`, **Stage 2** (a real
  `create_match` from `matchCreator.ts`, the creator-only `POST /api/game/:id/wager`
  endpoint, wager info on `GET /api/game/:id`, the host's stake control in
  `HostLobbyModal.ts`), and **Stage 3** (`onchainJoin.ts`'s real `join_match`,
  `WagerLobby.ts` mounted through `arena/wagerJoinFlow.ts` from `Main.ts`'s join funnel,
  wallet fields threaded `LobbyConfig` → `ClientJoinMessage`),
  **Stage 4** (`rpcClient.ts` reads and decodes the real `MatchAccount`), and
  **Stage 5** (`settler.ts` signs the correct digest and submits `settle_match`, or
  `cancel_match` when the lobby never filled).
- **The wager loop is closed end to end**: create escrow → stake → play → pay out,
  and **Stage 6** makes it exercisable locally without the closed-source auth API.
  All six integration stages are done — see the roadmap below for what is not.
- Wagering is inert unless `ARENA_PROGRAM_ID` is set.
- **Never run against mainnet in this state.** Beyond the client-vote risk below, none
  of this has been exercised against a live cluster — every proof so far is bankrun.
- **Dependencies**: `OpenFrontIO/package-lock.json` was out of sync with its
  `package.json` (arena scaffolding added `@solana/web3.js`/`tweetnacl` without locking
  them), so `npm ci` was impossible. Resolved with `npm install --ignore-scripts`.
  Use `npm run inst` from now on, per `OpenFrontIO/CLAUDE.md`.

## A wagered lobby must fill before it can start — now enforced
`settle_match` only accepts a match in `InProgress`, and `join_match` sets that status
only when `player_count` reaches `max_players`. A wagered lobby that starts with empty
staked seats therefore **cannot be paid out at all**, so every such match would be played
and then refunded.

Closed in three places, all gating on the same predicate — `wagerReadyToStart()` in
`arena/matchRegistry.ts`, which asks whether the escrow reports `InProgress`:

1. **`toggle_game_start_timer`** (`GameServer.ts`) rejects with `wager_lobby_not_full`
   and sends the host a `ServerErrorMessage` so the start button does not silently
   no-op. Disarming an already-armed timer is always allowed — otherwise a host whose
   cached fill state regressed would be stuck with a timer they cannot cancel.
2. **`cancelUnfilledWageredMatch()`**, called from `GameManager.tick()` beside the
   existing `cancelShortHandedMatch()`, cancels at the start deadline if the gate was
   somehow bypassed.
3. **The refund** (below) releases the stakes either way.

**Why `InProgress` and not a seat count:** it is the exact condition `settle_match`
requires, so the gate cannot drift from the settlement rule. A lobby the gate lets start
is one that can pay out; one it blocks could only ever have refunded.

**Why a cached value is acceptable:** `handleIntent` is synchronous and cannot await an
RPC, so the fill state is cached from the read `verifyOnchainMembership` already performs
on every wagered join — which is also the only moment it can change. Being wrong is safe
in both directions: blocking a startable match costs the host a retry, and allowing an
unstartable one still refunds through `settler.ts`.

`maxPlayers` on the wager still has to equal the number of players who will actually
play — the gate enforces it rather than merely documenting it, but it cannot conjure a
missing player.

## ⚠️ An abandoned wagered lobby used to strand its stakes
Fixed, but worth knowing because the shape of it will recur: **settlement rides on
`archiveGame()`, and `end()` returns before that whenever a game never started**
(`!_hasPrestarted && !_hasStarted`). A wagered lobby whose host never pressed start left
every stake sitting in the vault with nothing left to release it.

`end()`'s not-started branch now calls `refundWageredLobby()`, which delegates to the
existing `settle(gameId, null, allClients)`. No new settlement logic: `settle()` reads the
escrow itself and only refunds when the chain says `Open`, so a match that did somehow
reach `InProgress` is left alone rather than guessed at.

**This is the single refund site.** `cancelUnfilledWageredMatch()` deliberately does not
refund inline — it sets `_hasEnded`, `phase()` reports `Finished`, `GameManager` calls
`end()`, and the refund happens there. Anything else that cancels a wagered lobby
pre-start should route the same way rather than adding a second call.

Note also that `cancelUnfilledWageredMatch()` kicks with `kick_reason.wager_not_full`,
**not** `kick_reason.match_cancelled`: the latter's client handler pushes the player back
into the matchmaking queue, which is wrong for a private lobby the host built by hand.

## Roadmap — where this actually is
Full plan: `~/.claude/plans/where-are-we-on-staged-snowflake.md`. Phases, in
dependency order:

| Phase | What | State |
|---|---|---|
| **1** | Wagered start-gate + refund the unstartable | ✅ root `a283bfc`, ofio `c76ed24` |
| **2** | `ARENA_DEV_BYPASS` containment — dev must not move real tokens | **blocked on two decisions** (see below) |
| **H5** | Stop shipping upstream's identity (licensing) | ✅ ofio `8a9ab4d` |
| **H3** | Program: timeout-cancel for a stranded `InProgress` match | ✅ root `HEAD` |
| **H1** | Arena env vars + keypair mount through the deploy path | todo |
| **H2** | Recovery sweeper (master-only, enumerates by authority) | todo, needs H1+H3 |
| **H4** | Auth service — JWKS, `/auth/refresh`, `/auth/wallet`, `/users/@me` | todo |
| **H6** | The Oracle Cloud box | todo, needs a domain + region |
| **3** | Devnet deploy + live validation (S1–S7) | needs H3 first |
| **4** | Server-side replay winner determination | **mainnet gate** |

**Open decisions** blocking Phase 2: whether bypass-on + non-devnet RPC should
refuse to boot or only warn; and whether the client learns the bypass state from
`GET /api/game/:id` or is left to be rejected by the server.

**H1 is the next unblocked item.** H2's sweeper needs it, and H4/H6 need inputs.

### H3 — the `InProgress` escape hatch (done, and why it matters)
`settle_match` accepts only `InProgress`; `cancel_match` used to accept only
`Open`. A lobby that filled and then lost its server therefore had **no on-chain
path out at all** — that pot was locked permanently, and hosting makes server
restarts a certainty rather than an edge case.

`cancel_match` now also accepts `InProgress` once `MATCH_TIMEOUT_SECS` (24 h) has
elapsed since `created_at`. Notes:
- **The status gate moved off the `Accounts` struct into the handler**, because
  the `InProgress` case is conditional on the clock and an account constraint
  cannot express that. Anything editing that struct must leave the handler's
  `require!` in place — removing it lets the authority cancel a live match
  mid-play. A mutation test covers exactly this.
- **This does not widen who is trusted.** The authority already signs the digest
  that decides the payout, so it could always deny a winner; the timeout only
  adds a delayed refund that returns the money to the players.
- **`ArenaError` is append-only.** Anchor numbers variants positionally from
  6000, so inserting one silently renumbers every error after it — including the
  codes TypeScript matches on. `MatchNotTimedOut` is 6010; 6000–6009 are unmoved.
- **24 h is deliberately far longer than any match**, so it can never race a
  slow-but-live settlement. `settle_match` keeps working past the deadline — a
  server that recovers late still pays the winner, and a test asserts it.
- `MATCH_TIMEOUT_SECS` is marked `#[constant]`, so it reaches the IDL and the
  TypeScript mirror in `core/arena/arenaProgram.ts` is **diffed against it**
  rather than hand-copied. It is the only arena constant with a real IDL pin:
  `MAX_PLAYERS` is pinned indirectly by `MATCH_ACCOUNT_SIZE` and the field
  offsets, `MAX_RAKE_BPS` by `create_match`'s own rejection — the timeout had no
  such second anchor, and H2's sweeper reads it to decide when to try a cancel.

## Completed integration stages — notes worth keeping
Each stage was gated on `npx tsc --noEmit` (from `OpenFrontIO/`) before moving on.
Kept for the constraints they record, not as remaining work.

2. ~~**`matchCreator.ts`** — real `create_match` submission + `POST /api/game/:id/wager`
   + wager info on `GET /api/game/:id` + host UI.~~ **DONE.** Notes for later stages:
   - Bindings live in `OpenFrontIO/src/core/arena/arenaProgram.ts`; add `join_match`
     and `settle_match` builders there and extend `tests/arenaProgram.ts` alongside.
     `MATCH_ACCOUNT_LAYOUT` there is what Stage 4 should decode with.
   - The `nonce` seed is `sha256(gameId)[0..8]` read LE, so a match PDA is re-derivable
     from the game id alone — no counter to persist.
   - **`rakeBps` is not a host input.** It comes from `ARENA_RAKE_BPS` server-side; a
     lobby host must not choose the house's cut.
   - `createWageredMatch` has **no dev-mode shortcut on purpose**. Registering a lobby
     as wagered without a real escrow would advertise a stake nobody can win, so it
     throws instead and the lobby stays free-to-play.
   - Wagered lobbies are private-only, enforced in *both* directions: `/wager` rejects a
     listed lobby and `/listing` rejects a wagered one.
   - `settler.ts`'s duplicate keypair loader was removed in favour of
     `arena/serverKeypair.ts`, which is now the single place the authority key is read.
3. ~~**Client on-chain join** — `onchainJoin.ts`'s `join_match` submission;
   `WagerLobby.ts` signing + `walletSig`; mounting the wager step in `Main.ts`; threading
   the wallet fields into `ClientJoinMessage`.~~ **DONE.** Notes for later stages:
   - `arenaProgram.ts` **moved to `OpenFrontIO/src/core/arena/`**. It ships to the
     browser now, and nothing under `src/client/` may import from `src/server/`. It also
     gained `import { Buffer } from "buffer"` — the bare `Buffer` global is Node-only and
     was a latent runtime break in the browser (the same bug was fixed in
     `walletAuth.ts`, which had `Buffer.from(sig).toString("base64")`).
   - The client stake gate is **dynamically imported** in `Main.ts`
     (`await import("./arena/wagerJoinFlow")`). Static-importing it put
     `@solana/web3.js` — 294 kB / 86 kB gzipped — in the main chunk for every player,
     wagered or not. Keep it lazy; verify with `npx vite build` that
     `wagerJoinFlow-*.js` is still a separate chunk.
   - `WagerInfo` gained `programId` and `rpcUrl`, because the joining browser builds and
     submits its own transaction. `programId` is stored **per-match** in `WagerConfig`,
     not read from config at join time: repointing `ARENA_PROGRAM_ID` must not send a
     stake to a different program than the one holding the pot.
   - **The host must stake too.** `create_match` does not enrol the authority as a
     player. The host's `join-lobby` fires when the lobby view opens, before any escrow
     exists, so `HostLobbyModal.handleAttachWager` **re-dispatches `join-lobby`** on
     success to send the host back through the gate. `POST /wager` correspondingly
     rejects a lobby with more than one client connected (`wager_lobby_not_empty`) —
     anyone who joined before the escrow existed got in unstaked and cannot be made to
     stake retroactively.
   - `Main.ts` runs the gate **before** tearing down the existing lobby handle, so
     backing out of the stake prompt does not leave the player disconnected.
4. ~~**`rpcClient.ts`** — real `MatchAccount` fetch + fixed-offset decode +
   `players[0..player_count]` scan.~~ **DONE.** Notes for later stages:
   - The decoder is `decodeMatchAccount()` in `core/arena/arenaProgram.ts`, not in
     `rpcClient.ts`. It is **pure** — raw bytes in, `MatchAccountView` out — so bankrun
     can feed it what the program actually wrote. `rpcClient.ts` keeps only the thin
     `fetchMatchAccount(wager)` wrapper around the RPC call. **Stage 5 should rebuild
     standings from `fetchMatchAccount(...).players`**, which is trimmed to
     `player_count` and in join order — the order `settle_match`'s `scores` is indexed
     against.
   - `verifyOnchainMembership` now takes `(wager: WagerConfig, walletAddress)`; the
     `txSig` parameter is gone. `ClientJoinMessage.onchainTxSig` is still sent and is
     now **audit-only** — logged on a successful join so a disputed payout can be traced,
     but it authorises nothing.
   - Why the old check was unsafe: it only asserted that *some* confirmed transaction
     touched the match PDA. Any transaction naming the account satisfies that, including
     one that failed to stake, or one somebody else sent. Presence in `players[]` is
     proof of payment because the program writes it only after `token::transfer`.
   - The decoder validates **owner, discriminator, length, `MatchStatus` range and
     `player_count <= max_players`** before trusting a field. The owner check is the
     load-bearing one: without it any account of the right length decodes into a
     plausible match. `tests/arenaProgram.ts` asserts each rejection.
   - `verifyOnchainMembership` retries the read 3× at 400 ms. The joining browser may be
     on a different RPC (`ARENA_PUBLIC_RPC_URL`) than the server, and a node briefly
     behind would otherwise kick a player who genuinely paid.
   - It also refuses a `Settled`/`Cancelled` match, and refuses one whose on-chain
     `mint`/`vault`/`entry_fee` disagree with the registry entry.
5. ~~**`settler.ts`** — correct digest, standings from on-chain `players[]`, Ed25519
   instruction at index 0, submission.~~ **DONE.** Notes:
   - The digest is `sha256(matchPDA || winner || scores_u64_le)` — raw bytes, no
     separators, no JSON. `settleMessagePreimage()` in `core/arena/arenaProgram.ts`
     builds the preimage (pure, browser-safe); the caller hashes it, because sha256 has
     no synchronous cross-realm implementation. A wrong preimage produces a perfectly
     valid signature the program rejects, and the pot stays locked — so
     `tests/arenaProgram.ts` executes a real settlement and asserts the token balances
     moved, plus that the digest **binds the scores** (sign one vector, submit another →
     rejected) and that a non-authority signature is refused.
   - The ed25519 instruction is built with web3.js's `Ed25519Program`, not the
     hand-rolled `buildEd25519InstructionData` from `tests/arena.ts`. Byte order inside
     the payload differs from that helper (pubkey before signature), which does not
     matter — the program reads the header offsets — and the canonical builder is less
     likely to drift from what the runtime verifier expects.
   - **`settle_match` requires `InProgress`, which only happens when the lobby fills.**
     `join_match` flips `Open -> InProgress` at `player_count == max_players`. A wagered
     lobby that plays out with empty seats can therefore never be settled. `settler.ts`
     detects `Open` and **refunds via `cancel_match`** instead. Do not "fix" this by
     relaxing the program's status check — the refund is the correct outcome.
   - Failure paths deliberately leave the pot in escrow rather than guessing: unknown
     winner, team win (the program pays exactly one wallet), a winner who did not stake.
     Each logs; none submits.
   - `settle_match`/`cancel_match` pay into accounts they do not create, and `join_match`
     accepts any token account with the right owner and mint — so a staker may have no
     canonical ATA. `ensureTokenAccount()` creates one first, in **its own transaction**
     so it cannot push the settle tx over the size limit or disturb the
     ed25519-at-index-0 requirement.
   - `TREASURY_TOKEN_ACCOUNT` is only required when `ARENA_RAKE_BPS > 0`. At 0 bps the
     program still wants the account but transfers nothing to it, so the winner's own
     token account is passed. With rake > 0 and no treasury configured, settlement is
     **refused** rather than sending the rake somewhere arbitrary.
   - The old dev-mode short-circuit is gone. A registry entry always means a real
     on-chain escrow, so skipping submission in dev would not avoid touching the chain —
     it would strand real tokens.
6. ~~**Dev-mode auth bypass** — symmetric `jti` bypass in the wagered-join gate.~~
   **DONE.** Notes:
   - The nonce the wallet signs is normally the JWT's `jti`, which binds the signature to
     one login session. Dev sessions are anonymous — `getPlayToken()` returns a bare
     persistentID and `verifyClientToken` returns `claims: null` for it — so there was no
     nonce and the wagered path could not be exercised locally at all.
   - The dev substitute is the **game id**, not the persistentID: the latter is PII the
     wallet would display in its signing prompt, and `Auth.ts` is explicit that it must
     not be exposed. The game id still binds the signature to one match; what it gives
     up is the session binding, which is exactly why it is refused outside dev.
   - Both halves must choose the nonce identically, so the choice and the message format
     live in one shared place, `core/arena/authMessage.ts`. The prefix used to be
     declared twice with a "must match server" comment — the classic silent-drift setup,
     where the only symptom is an unexplained invalid-signature disconnect.
   - The client refuses **before** prompting the wallet when a non-dev session has no
     `jti`, so nobody is asked to sign something the server will reject.
   - `tests/ArenaWalletAuth.test.ts` signs with the client code and verifies with the
     **real** `verifyWalletSig`, not a copy of it, so the two ends cannot drift apart.

### Testing the wager loop locally — read this first
Two things will otherwise waste an afternoon:

- **The dev bypass on the on-chain membership check is separate and still active.**
  `Worker.ts` skips `verifyOnchainMembership` in dev, so a dev player joins a wagered
  lobby whether or not they actually staked. Since that read is also what feeds the
  start-gate's cached fill state, an unstaked dev lobby now **refuses to start at all**
  (`wager_lobby_not_full`) rather than playing and refunding. To exercise a payout
  locally, every seat has to genuinely `join_match`.
- **Wagering needs a deployed program**, a funded `SERVER_KEYPAIR_PATH`, and
  `ARENA_PROGRAM_ID` set. With `ARENA_PROGRAM_ID` empty the host UI hides the stake
  control and every lobby stays free — which is the correct default, not a failure.

## Hosting this fork — three licences, and none of them are optional
Landed in Phase H5 (`OpenFrontIO` `8a9ab4d`). Details in
`OpenFrontIO/docs/branding.md`; the short version, because each of these is easy
to silently undo:

- **`proprietary/` must stay empty.** It held OpenFront's wordmark, logos,
  favicon, `OpenFront.ttf` and the background music, all *All Rights Reserved* and
  explicitly not redistributable. The directory and the build plumbing remain so a
  licensed copy can be restored — but do not restore the assets, and reject any
  upstream merge that re-adds them. `listHashedPublicAssetPaths` skips a missing
  source dir, so nothing breaks without them; the font and music failures are
  already caught (`Main.ts`'s `FontFace` catch, `SoundManager`'s `safely()`).
- **Do not reinstate upstream's analytics.** `index.html` used to carry
  OpenFront's own Google Ads and GA4 properties. In a fork those report your
  traffic into their accounts. `tests/server/AppShellBranding.test.ts` asserts
  their absence precisely because `index.html` is a merge target.
- **AGPL v3 §13 is the load-bearing one.** Offering a modified version over a
  network obliges you to offer its users *that version's* source. The mechanism is
  the footer link, driven by `SOURCE_REPO_URL`. Unset means the footer points at
  upstream, which is only honest for an unmodified build.
- **§7 additional terms cut both ways:** preserve copyright notices (so
  `CREDITS.md`, the upstream links and `proprietary/LICENSE` stay), but do not
  present this as official OpenFront (so the name, logo and page title must
  change). The page title is still `OpenFront (ALPHA)` — it is a Crowdin-managed
  string in `en.json`, so it waits on the name.

`index.html` is EJS rendered only at request time, so a variable the server
forgets to pass is a **production `ReferenceError` that tsc and lint cannot see**.
`AppShellBranding.test.ts` is the only thing that renders the template — extend it
when you add a template variable.

## Conventions
- Commits: conventional commits (`feat(arena):`, `fix(program):`, …).
- Inside `OpenFrontIO/`, mark every edit to a pre-existing upstream file with an
  `// [ARENA]` comment — see `OpenFrontIO/docs/upstream-map.md`. This keeps upstream
  merges tractable.
- Checks before declaring done:
  - Program: from WSL, `anchor build && anchor test --skip-deploy --skip-local-validator`
  - Game: from `OpenFrontIO/`, `npx tsc --noEmit`, `npm run lint`, **and `npm test`**
    (`vitest run && vitest run tests/server`). Do not skip the vitest run: `en.json`
    additions are checked for **nested** key ordering by `tests/EnJsonSorted.test.ts`,
    which tsc and lint know nothing about. Stage 3 shipped an unsorted `wager_lobby`
    block that stayed broken until Stage 6 because only tsc/lint/build were run.
  - `OpenFrontIO` tsc is **clean — zero errors**. It carried 2 pre-existing errors
    until Stage 5 (`arena/settler.ts` possibly-undefined, `GameServer.ts`
    null-assignability); both are gone. Any error at all now means you introduced it.
  - `npm run lint` must be **clean** — it is, as of Stage 2. Run
    `npx prettier --write` on changed files too; lint does not cover formatting, and the
    repo's prettier config reorders imports.
  - Changing `programs/arena/` means re-running `anchor build` *before* the tests —
    `tests/arenaProgram.ts` diffs against the generated IDL, so a stale one hides drift.
- The `run-openfront` skill in `OpenFrontIO/.claude/skills/` is written for headless
  Ubuntu + Playwright and does not apply directly on this Windows machine. Use the
  human path: `npm run dev`, then open `http://localhost:9000`.

## Environment Variables
`OpenFrontIO/.env` (add to `example.env` as they land):
- `SOLANA_RPC_URL` — RPC endpoint
- `SERVER_KEYPAIR_PATH` — server ed25519 keypair; **must be the same keypair** used as
  match `authority` in `create_match` and as signer in `settle_match`. Loaded in exactly
  one place, `arena/serverKeypair.ts` — don't add a second loader.
- `ARENA_PROGRAM_ID` — deployed program id. **Leaving it empty disables wagering
  entirely**: the host UI hides the stake control and every lobby stays free to play.
- `ARENA_PUBLIC_RPC_URL` — RPC endpoint handed to **joining browsers**, which submit
  their own `join_match`. Falls back to `SOLANA_RPC_URL`; set it separately if that one
  embeds an API key, because this value is served to every player.
- `ARENA_RAKE_BPS` — house cut, 0..1000. Operator-set, never host-set.
- `TREASURY_TOKEN_ACCOUNT` — rake destination token account (needed once rake > 0)
- `SITE_NAME` — public display name, used for `og:title`. Falls back to `DOMAIN`.
- `SOURCE_REPO_URL` — where **this** deployment's source lives. Drives the footer
  link. **Unset is an AGPL problem, not a cosmetic one** — see below. The master
  logs a warning at boot outside dev.
- Existing OpenFront vars (`GAME_ENV`, `API_KEY`, `DOMAIN`, …) — see its `example.env`

**Ops requirement:** the server keypair needs a funded SOL balance to pay rent for each
match's `MatchAccount` and vault ATA. Use a devnet faucet for testing.
