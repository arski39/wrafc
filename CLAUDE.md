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
- `anchor test --skip-deploy --skip-local-validator` — **27 passing, 0 failing.**
  - `tests/arena.ts` (7): happy path, rake math, double-join rejected, bad-signature
    rejected, plus the three `cancel_match` tests (refund, non-authority rejected,
    already-started rejected).
  - `tests/arenaProgram.ts` (20): pins the hand-rolled program bindings
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
- **Tests**: 27 passing across `tests/arena.ts` (program behaviour) and
  `tests/arenaProgram.ts` (the shared program bindings, decoder and settlement).
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
- **The wager loop is closed end to end**: create escrow → stake → play → pay out.
  What remains is Stage 6 (a dev-mode auth bypass so the path can be exercised locally)
  and the open issues below.
- Wagering is inert unless `ARENA_PROGRAM_ID` is set.
- **Never run against mainnet in this state.** Beyond the client-vote risk below, none
  of this has been exercised against a live cluster — every proof so far is bankrun.
- **Dependencies**: `OpenFrontIO/package-lock.json` was out of sync with its
  `package.json` (arena scaffolding added `@solana/web3.js`/`tweetnacl` without locking
  them), so `npm ci` was impossible. Resolved with `npm install --ignore-scripts`.
  Use `npm run inst` from now on, per `OpenFrontIO/CLAUDE.md`.

## ⚠️ A wagered lobby must fill, or it refunds
`settle_match` only accepts a match in `InProgress`, and `join_match` sets that status
only when `player_count` reaches `max_players`. A wagered lobby that starts with empty
staked seats therefore **cannot be paid out at all** — the program will refuse it.

`settler.ts` handles this by refunding every staker via `cancel_match` instead of
leaving the pot in the vault, so no money is lost. But from a player's point of view the
match was played and nobody won it, which is a poor experience.

The operational rule is: **`maxPlayers` on the wager must equal the number of players
who will actually play.** There is currently nothing in the lobby UI enforcing that the
host waits for every staked seat before starting, which is worth closing before this is
used for anything real.

## Task Queue — remaining work, in order
Each stage is gated on `npx tsc --noEmit` (from `OpenFrontIO/`) before moving on.

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
  - Program: from WSL, `anchor build && anchor test --skip-deploy --skip-local-validator`
  - Game: from `OpenFrontIO/`, `npx tsc --noEmit` and `npm run lint`
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
- Existing OpenFront vars (`GAME_ENV`, `API_KEY`, `DOMAIN`, …) — see its `example.env`

**Ops requirement:** the server keypair needs a funded SOL balance to pay rent for each
match's `MatchAccount` and vault ATA. Use a devnet faucet for testing.
