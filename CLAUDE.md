# CLAUDE.md — Solana Wager Arena (OpenFrontIO + Anchor escrow)

## Project Overview
A skill-based wagering layer on top of **OpenFront.io**, a real-time multiplayer
territorial-conquest game. Players stake SPL tokens into an on-chain escrow, play a
normal OpenFront match, and the winner is paid out from escrow by a Solana program
that verifies a server ed25519 signature over the result.

Two components:
1. `programs/arena/` — Anchor program. Five instructions: `create_match`,
   `join_match`, `settle_match`, `cancel_match`, `close_match`. Tested by
   `tests/arena.ts` and `tests/arenaProgram.ts` (bankrun), plus
   `tests/surfpool/` against a really-deployed program.
2. `OpenFrontIO/` — the game itself, a **nested git repository with its own history
   and its own `CLAUDE.md`**. Read `OpenFrontIO/CLAUDE.md` before touching anything
   inside it. The wager integration lives in `OpenFrontIO/src/server/arena/` and
   `OpenFrontIO/src/client/arena/`.

## Toolchain — WSL only

The Solana/Anchor toolchain does not run natively on Windows here. **Do not
downgrade any part of this combination** — see "Why these versions".

| Component | Version |
|---|---|
| WSL distro | Ubuntu (WSL2) |
| Host Rust | stable (1.98.0 at time of setup) |
| Solana CLI | Agave 4.2.1 (`cargo-build-sbf` 4.1.0, platform-tools **v1.54**) |
| Anchor CLI | 0.31.1 (via `avm`) |
| Node (in WSL) | 20.x + yarn |

### The two commands you actually run

```bash
cd "/mnt/c/Users/Aaro Eskelinen/SOLANA WAGER konsepti"
anchor build
anchor test --skip-deploy --skip-local-validator
```

**Both flags are required.** `--skip-local-validator` alone still tries to
*deploy* to `127.0.0.1:8899` and fails; these tests need no validator at all,
because bankrun runs an in-process SVM and loads `target/deploy/arena.so`
directly.

`npm install` for the root test deps **must run inside WSL** — `solana-bankrun`
is a native NAPI module and the Windows binaries will not load under Linux. Root
installs also need `--legacy-peer-deps` (see Test-suite gotchas).

<details>
<summary>One-time WSL provisioning</summary>

```powershell
wsl --install -d Ubuntu --no-launch
```

```bash
# --- run as root inside: wsl -d Ubuntu -u root ---
apt-get update
apt-get install -y build-essential pkg-config libssl-dev libudev-dev zlib1g-dev \
    llvm clang cmake make libprotobuf-dev protobuf-compiler curl git bzip2 ca-certificates

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
export PATH="$HOME/.cargo/bin:$PATH"

sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"   # stable channel, not a pin
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -       # Anchor.toml shells out to yarn
apt-get install -y nodejs && npm install -g yarn

cargo install --git https://github.com/coral-xyz/anchor avm --tag v0.31.1 --locked --force
export PATH="$HOME/.avm/bin:$PATH"
avm install 0.31.1 && avm use 0.31.1

solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json
```
</details>

### Why these versions (do not "simplify" this)
Anchor 0.30.1 + Solana 1.18.26 + Rust 1.79 **cannot build this project**:

1. Transitive deps adopted **edition2024** during 2025, which Rust 1.79 cannot
   parse. Pinning them back does not converge — `blake3` → `digest` →
   `block-buffer`, then `proc-macro-crate` → `toml_edit`, then `getrandom`, …
2. Upgrading only the *host* Rust does not help: `cargo-build-sbf` uses the Rust
   in **platform-tools**, and both Solana 1.18.26 and Agave 2.1.21 ship Rust
   1.79. Only platform-tools **v1.54** (Agave 4.x) is new enough.
3. Anchor 0.30.1 cannot generate an IDL on a modern registry at all — `anchor-syn`
   calls `proc_macro2::Span::source_file()`, since removed. The IDL build
   re-resolves under a separate cargo, so lockfile pins do not reach it.

`Cargo.lock` is committed. Keep it committed.

## Status — ✅ GREEN
- `anchor build` produces `target/deploy/arena.so`, `target/idl/arena.json`
  (five instructions, **19** errors, one `#[constant]`), `target/types/arena.ts`,
  at the real program id `4CGRLB5WJ4LK4nqwhzN5uhU78cakuHzG5wfrUZrQ2G64`.
- **50 bankrun tests passing** — `tests/arena.ts` (25) for behaviour,
  `tests/arenaProgram.ts` (25) for the shared bindings, decoder and settlement.
- **3 more under `npm run test:surfpool`**, not part of `anchor test`, against a
  really-deployed program on a local Surfpool validator — the only way to reach
  the 24-hour deadline, and the only proof the program is *deployable* rather
  than merely loadable. See `docs/surfpool.md`.
- **3740 game-side tests** (`npm test` from `OpenFrontIO/`, which runs the suite
  then re-runs `tests/server`, so those are counted twice — 3127 + 613).
- The wager loop is closed end to end: create escrow → stake → play → pay out,
  with the winner derived by server-side replay rather than a client vote.
- **Nothing has run against a live cluster.** Surfpool and bankrun are both
  local. Devnet validation is Phase 3.

### `tests/arenaProgram.ts` — why there is no Anchor client
Arena instructions are built **byte by byte** rather than through
`@coral-xyz/anchor`: the same module ships to the browser for the client-side
`join_match`, and Anchor's coder is a large bundle for five instructions. The
cost is constants that can silently drift from the program, so that suite pins
both ends:

1. every discriminator, field offset, account order and arg order is **diffed
   against the generated `target/idl/arena.json`**, and
2. the instructions that would actually be sent are **executed against the real
   program in bankrun**, then read back through `decodeMatchAccount` — the same
   decoder the server uses — including its rejection paths.

Either half alone is insufficient — (1) would pass against a stale IDL, (2) would
pass on a layout that merely round-trips. Keep both when adding an instruction.

**The discriminator trap this exists to catch:** Anchor 0.31 names instructions in
**snake_case** in the IDL; 0.30 used camelCase. The discriminator is
`sha256("global:" + name)[0..8]`, so hashing `createMatch` instead of `create_match`
yields eight entirely different bytes — a mistake nothing catches until the chain
rejects the transaction. The suite asserts both that the pinned values match the
IDL and that they are *not* the camelCase hash.

**The root suite imports across into `OpenFrontIO/`** (root `tsconfig.json`
excludes it, but `exclude` only filters the `include` globs — imported files still
compile). That works only because the modules it reaches — `core/arena/arenaProgram.ts`
and `core/arena/stakeTiers.ts` — import nothing but `@solana/web3.js` and `buffer`.
**Keep both free of OpenFrontIO imports** or the root suite stops building, and
**free of Node built-ins** or the browser bundle breaks at runtime. `buffer` is the
one allowed exception: Node prefers its own builtin for that bare specifier while
bundlers resolve the npm package, so it works in both realms — unlike the bare
`Buffer` global, which type-checks via `@types/node` and is `undefined` in a browser.

### Test-suite gotchas (all cost real debugging time — don't reintroduce)
- **Never use `@solana/spl-token`'s action helpers** (`createMint`, `mintTo`,
  `createAssociatedTokenAccount`, `getAccount`) in these tests. They call
  `connection.sendTransaction`, and `BankrunProvider.connection` is a BanksClient shim,
  not a real `Connection`. Use the instruction builders plus the local `sendTx()` /
  `getTokenAccount()` helpers.
- **`settle_match` requires `.signers([authority])`** — it takes the authority as a
  signer *as well as* an attester. The suite's `serverKp` is a raw
  `nacl.sign.keyPair()`, so wrap it:
  `Keypair.fromSecretKey(Buffer.from(serverKp.secretKey))` — nacl's 64-byte
  secret key is already the web3.js layout.
- **Players run out of tokens.** They are minted 1000 each and every join costs
  `ENTRY_FEE`, so a long suite exhausts them and the next join fails with
  `FeeMismatch` — which looks exactly like a bug in whatever is under test. Call
  `topUpPlayers()`. It varies the amount by one per call on purpose; see the
  blockhash note below.
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
- **Reading that prelude means checking the three `*_instruction_index` fields.**
  They are the difference between verifying a signature and being told one was
  verified. See the security invariants below; a mutation test proves it.
- `settle_match` **must** also take the authority as a `Signer`. The prelude
  proves *what was attested*; the signature on the instruction proves *who
  submitted it*, which is what stops a frontrunner redirecting the payout.
- Keep TypeScript strict. No `any` in new code except WebSocket message-parsing
  boundaries — type those with discriminated unions (OpenFrontIO uses Zod schemas in
  `src/core/Schemas.ts` for this).
- Do not add dependencies without stating why in the commit message.
- Never commit keypairs. `.env` and `*keypair*.json` are gitignored — keep it that way.
- When touching settlement math or account layout, add/update a bankrun test in the
  same change.

---

## 🔴 Security invariants — each one is load-bearing

A security pass (root `f8a2eac`, ofio `0af5e23`) over `programs/arena/` found four
live vulnerabilities before any deploy. The fixes are below. **Every one has a
mutation test**: break the check on purpose, rebuild, and confirm the named test
fails. A test that still passes without the fix is not testing the fix.

### 1. The ed25519 prelude — pin all three instruction indices

`Ed25519SignatureOffsets` carries three `*_instruction_index` fields that decide
*which instruction in the transaction* the precompile reads the signature, pubkey
and message from. Only `u16::MAX` means "this one"; any other value indexes into
the transaction's **other** instructions (Agave's `precompiles/src/ed25519.rs`,
`get_data_slice`).

Unpinned, an attacker points the precompile at their own instruction carrying
their own key, message and signature — which verifies fine — while laying out
instruction 0 so that the same offsets hold the authority's pubkey and the
expected digest. The precompile returns Ok; the program reads the filler; the pot
pays out to whoever asked. **Any player in any wagered match could take the whole
pot at will.** A documented class, not theoretical:
[Cantina](https://www.cantina.security/blog/signature-verification-risks-in-solana),
[Asymmetric on Relay](https://blog.asymmetric.re/wrong-offset-bypassing-signature-verification-in-relay/).

The fix pins all three to `u16::MAX`, plus `num_signatures == 1` and a **16-byte**
minimum (`message_instruction_index` lives at `d[14..16]`; the old check was `>= 14`).
With the indices pinned, the bytes the precompile verified *are* the bytes the
program reads. Deliberately layout-agnostic rather than pinning exact offsets,
because web3.js's `Ed25519Program` orders the payload pubkey-then-signature while
`tests/arena.ts`'s helper does signature-then-pubkey.

*Mutation test:* `rejects a prelude whose offsets point at another instruction`.

**A sibling attack that does *not* work**, checked so nobody re-derives it:
`num_signatures = 0` is refused by the precompile itself
(`num_signatures == 0 && data.len() > 2` → `InvalidInstructionDataSize`).

### 2. `cancel_match` — refund accounts must be paired to `players[]`

`ctx.remaining_accounts[i]` went straight into `token::transfer` with nothing
checking it belonged to `players[i]`. Each refund account is now deserialized and
checked for `owner == players[i]` and `mint == match_account.mint`. Done by hand
rather than with `Account::try_from`, which would force the context's `'c`
lifetime to `'info`; the explicit `owner == token::ID` check is load-bearing,
because `TokenAccount::try_deserialize` only unpacks and any 165-byte account
would otherwise decode.

*Mutation test:* `cancel_match refuses a refund account that is not the staker's`.

### 3. The digest does not bind the payout destination — so two other things do

`sha256(match_pda ‖ winner ‖ scores)` says *who won*, not *where the money goes*.
Two independent fixes, both kept:

- `winner_token.owner == winner`, so a frontrunner's only possible outcome is the
  intended one.
- **`authority: Signer` on `SettleMatch`**, which closes the race outright and is
  free — `settler.ts` already signs as fee payer.

### 4. The rake destination is fixed at `create_match`

`treasury_token` was unconstrained and is not in the digest, so the authority
chose where the rake went at settlement time with nothing on chain to check it
against. It is now **recorded on `MatchAccount` at `create_match`** and
`settle_match` refuses any other account. This deliberately does not touch the
digest — the digest format is a Hard Rule, and binding a destination into it
would break every signer.

- **`treasury` is appended after `bump`.** Borsh packs in declaration order, so
  appending left every existing offset unchanged: the TypeScript mirror gained
  one offset instead of eleven shifting. `MATCH_ACCOUNT_SIZE` is **806**.
- **It is an instruction argument, not an `Account<TokenAccount>`.** At
  `rake_bps == 0` there is no treasury to name, and an optional account would put
  that into the IDL and the hand-rolled builder for no gain. The account is
  validated where it is real: `settle_match` pins its address **and**,
  unconditionally as an account constraint, its **mint**.
- **The address pin is conditional on rake, so it lives in the handler**, not the
  `Accounts` struct. Anything editing that function must leave the `require!` in place.
- **`create_match` refuses `rake_bps > 0` with no treasury** (`TreasuryRequired`) —
  the on-chain half of a rule `preflight.ts` already enforces at boot.
- **`settler.ts` reads the treasury from the match, not from its own env**, so an
  operator who repoints `TREASURY_TOKEN_ACCOUNT` cannot redirect the rake on a
  match created under the old one.

*Mutation test:* `REJECTS a settle that redirects the rake to another account`.

### `pot = vault.amount` is correct here — do not "fix" it

The instinct is to switch to `sum(stakes)`. The warning that prompts it targets
share maths, where a donation dilutes other claimants. This is winner-take-all
with a single claimant: a donor can only hand their own tokens to the winner.
Reading the balance also keeps the vault self-emptying, which is what lets
`close_match` reclaim the rent — `sum(stakes)` would strand donations *and* block
the close. The rake maths uses `checked_mul`/`checked_div`, converting a
settlement-locking panic into a named error.

### `close_match` — rent reclamation

Without it every match this key created held its rent (~0.0085 SOL: an 806-byte
`MatchAccount` plus a 165-byte vault ATA) and stayed in the sweeper's
`getProgramAccounts` scan for the life of the key. It takes a `Settled` or
`Cancelled` match with an empty vault, closes the vault via CPI and lets Anchor's
`close = authority` handle the match account — zeroing, reassigning and
deallocating, which is what stops a revival attack. Anchor closes after the
handler returns, so the PDA is still live to sign for its own vault.

The sweeper calls it in a second pass, capped at `MAX_CLOSES_PER_SWEEP` (20) so
the first sweep does not fire hundreds of transactions at once. A close that
fails is logged and skipped, not retried — the realistic cause is a donated-into
vault, which is never empty.

---

## Phase 4 — the server decides the winner by replaying the match

A wagered match settles on a winner the server derives itself, not on the
client-majority vote. This is what makes public wagered lobbies defensible at all.

**Why replaying is authoritative and the vote is not.** OpenFrontIO's simulation
runs **on each client** (see `OpenFrontIO/CLAUDE.md` → "Simulation Flow"); the
server only relays intents, so the old `handleWinner`/`VoteTally` path signed a
payout for a result it never checked — and in a 1v1, "a majority of clients" is
trivially colluded. The server does not need their answer: it already holds the
turn log it relayed, the `GameStartInfo` it assembled, the map, and the seed
(`simpleHash(gameID)`). `src/core` is deterministic by construction (seeded PRNG,
no floating point), so re-running those inputs reproduces the match. Colluders
can still *throw* a game — ordinary bad play, not fraud — but they cannot declare
a winner that did not win.

| File | Role |
|---|---|
| `arena/replayVerifier.ts` | Pure. Turn log in, verdict out. No RPC, no chain. |
| `arena/NodeMapLoader.ts` | Filesystem `GameMapLoader`. Two layouts — see below. |
| `arena/replayWorker.ts` | Worker-thread entry. |
| `arena/replayProbeWorker.ts` | Second worker, for the boot probe's recording pass. |
| `arena/replayRunner.ts` | Spawns them with a deadline; never throws. |
| `arena/replayProbe.ts` | Boot probe gating `ARENA_PUBLIC_WAGER_LOBBIES`. |
| `arena/verifiedSettle.ts` | What to do with the verdict. |

### Three decisions worth not re-litigating

**It runs on a worker thread, not inline.** The headless core does ~275 ticks/sec,
so at a 100 ms turn interval a 30-minute match is ~18,000 ticks — about a minute
of solid CPU, with the 3-hour cap near six and a half. Inline, that would stall
every other live game on the worker. `REPLAY_TIMEOUT_MS` is 15 minutes: better
than 2x headroom, and far inside the escrow's 24h timeout so a wedged replay
cannot hold a pot hostage.

**A hash mismatch refuses; it does not lose to the vote.** Per-turn hashes do
*not* decide the winner — they are client-supplied, and a colluding majority
could agree on anything. They are a **drift** check: if this build no longer
reproduces what the players saw, the game just replayed is not the game that was
played. The verdict is `ok: false` and settlement is skipped entirely, leaving
the pot for the 24h timeout to refund. Fail closed: refusing to pay is
recoverable, paying the wrong wallet is not.

**"Could not verify" never falls back to the vote.** That would reinstate exactly
the trust being removed, precisely when something is already wrong. A verified
replay that *disagrees* with the vote pays the replayed winner and logs loudly —
that is what a collusion attempt looks like from the server's side, and equally
what a simulation bug looks like. *Mutation-checked:* make a failed verification
fall back and two tests in `ArenaVerifiedSettle.test.ts` fail.

### ⚠️ The image has no `resources/maps` — the loader must not assume it does

`Dockerfile` deletes `resources/maps` after the build, because `build-prod`
already emitted a content-hashed copy of every one of those files under
`static/_assets/maps`. Both trees are **499 MB**; shipping both is ~1 GB of
duplicated map data for nothing.

Upstream's comment there said the maps were "not used by the server", which
stopped being true when Phase 4 landed. `NodeMapLoader` therefore resolves
through **`static/asset-manifest.json`** — the semantic *name → hashed url*
mapping the build emits — whenever the plain directory is absent, and throws
naming **both** locations when neither is.

- **`asset-manifest.json`, not `asset-hashes.json`.** The latter is keyed by the
  already-hashed emitted path and carries integrity data, so it cannot answer
  "where did `map.bin` go".
- **Manifest hrefs go through `normalizeAssetPath`**, which decodes per segment
  and rejects `.`/`..`, so a manifest cannot name a path outside `static/`.
- **Do not delete `static/_assets/maps`**, and do not restore `resources/maps`
  to the image expecting the loader to need it.
- **`ReplayInput.staticDir` exists only so tests can deny both layouts.**
  Production leaves it undefined and the loader resolves `static/`
  module-relative — the worker thread inherits nothing about where it started.

This was invisible to tsc and to every unit test, because a checkout has the
directory. In the image it made **every wagered match fail verification and
refund on the escrow's 24 h timeout**, and kept `ARENA_PUBLIC_WAGER_LOBBIES`
permanently unhonourable. *Mutation-checked twice:* force the directory resolver
and both `ArenaNodeMapLoader.test.ts` and `ArenaReplayProbe.test.ts`'s
`verifies a match with only the image's hashed map assets` fail.

**`npm ci --ignore-scripts` in the build stage is load-bearing too**, matching
`npm run inst`: `canvas` is a devDependency with an install script and
node-canvas publishes no linux-arm64 prebuild, so plain `npm ci` drops into
node-gyp and dies on the ARM box. Nothing under `src/` imports it.

### ⚠️ ONE SIMULATION PER PROCESS — the sharpest edge here

`loadTerrainMap` memoizes by `map:size` in a module-level `loadedMaps` and hands
every caller the **same `GameMap` object**, into which the simulation writes
territory ownership. A second game in the same process therefore does not start
on an empty board — it starts on whatever the first game conquered, and state
hashes diverge from tick 10 onward. That is a silent wrong answer, and for a
wagered match a silent wrong answer is a payout to the wrong wallet.

Found by two identical runs disagreeing in a test, not by reading the code.

`replayVerifier` now **refuses** a second simulation rather than answering. It
never fires in production — one fresh worker thread per verification means a
fresh module registry and an empty cache — but it is what stops someone later
moving verification inline "to avoid the thread", or batching two matches into
one worker. `tests/server/ArenaReplayVerifier.test.ts` gets its clean process via
`vi.resetModules()` per run for the same reason, and it is also why the boot
probe needs **two** worker threads rather than a `mode` flag on one.

`ArenaReplayVerifier.test.ts` runs the real core: it simulates a short game,
treats those hashes as what the players saw, and re-derives the same game — the
determinism claim itself, which no fixture could show.

---

## Wagered lobby lifecycle — three rules that must not drift

### A wagered lobby must fill before it can start
`settle_match` only accepts `InProgress`, and `join_match` sets that only when
`player_count` reaches `max_players`. A wagered lobby that starts with empty
staked seats therefore **cannot be paid out at all**.

All three gates ask the same predicate — `wagerReadyToStart()` in
`arena/matchRegistry.ts`, which asks whether the escrow reports `InProgress`:

1. **`toggle_game_start_timer`** (`GameServer.ts`) rejects with
   `wager_lobby_not_full` and sends the host a `ServerErrorMessage`. Disarming an
   already-armed timer is always allowed — otherwise a host whose cached fill
   state regressed would be stuck with a timer they cannot cancel.
2. **`cancelUnfilledWageredMatch()`**, from `GameManager.tick()`, cancels at the
   start deadline if the gate was somehow bypassed.
3. The refund below releases the stakes either way.

**Why `InProgress` and not a seat count:** it is the exact condition
`settle_match` requires, so the gate cannot drift from the settlement rule.

**Why a cached value is acceptable:** `handleIntent` is synchronous and cannot
await an RPC, so the fill state is cached from the read `verifyOnchainMembership`
already performs on every wagered join — which is also the only moment it can
change. Wrong in either direction is safe: blocking a startable match costs a
retry, allowing an unstartable one still refunds.

### There is exactly one refund site for a lobby this process still holds

Settlement rides on `archiveGame()`, and `end()` returns before that whenever a
game never started (`!_hasPrestarted && !_hasStarted`) — which used to strand
every stake in an abandoned lobby. `end()`'s not-started branch now calls
`refundWageredLobby()`, delegating to `settle(gameId, null, allClients)`. No new
settlement logic: `settle()` reads the escrow itself and only refunds when the
chain says `Open`.

**Anything else that cancels a wagered lobby pre-start must route the same way**
rather than adding a second call. `cancelUnfilledWageredMatch()` deliberately does
not refund inline — it sets `_hasEnded`, `phase()` reports `Finished`,
`GameManager` calls `end()`, and the refund happens there.

The H2 sweeper is not an exception; it is what happens when the rule has nobody
left to apply it. It refunds only escrows **no `GameServer` exists for any more**.
The two cannot collide, and not by luck: the sweeper's `Open` window starts an
hour *past* `maxGameDuration`, which is exactly when `end()` has already run.

Note `cancelUnfilledWageredMatch()` kicks with `kick_reason.wager_not_full`,
**not** `kick_reason.match_cancelled` — the latter's client handler pushes the
player back into the matchmaking queue, wrong for a hand-built private lobby.

### An unfilled lobby refunds; do not relax the program to settle it
`settler.ts` detects `Open` and refunds via `cancel_match`. Do not "fix" this by
relaxing the program's status check — the refund is the correct outcome.

---

## Roadmap

Full plan: `~/.claude/plans/where-are-we-on-staged-snowflake.md` (note: parts of
it are stale — it predates `close_match`, the 806-byte account, and Phase 4).
The live plan to a public devnet site is
`~/.claude/plans/jazzy-moseying-ullman.md`.

| Phase | What | State |
|---|---|---|
| **1** | Wagered start-gate + refund the unstartable | ✅ root `a283bfc`, ofio `c76ed24` |
| **2** | `ARENA_DEV_BYPASS` containment + stake cap | ✅ ofio `cecbe4b` |
| **H5** | Stop shipping upstream's identity (licensing) | ✅ ofio `8a9ab4d` |
| **H3** | Program: timeout-cancel for a stranded `InProgress` match | ✅ root `552425c` |
| **H1** | Arena env vars + keypair mount + boot preflight | ✅ ofio `f1b3832` |
| **H2** | Recovery sweeper (master-only, enumerates by authority) | ✅ ofio `fca7567` |
| **H4** | Auth service — JWKS, `/auth/refresh`, `/auth/wallet`, `/users/@me` | ✅ ofio `95e4b56` |
| **4** | Server-side replay winner determination | ✅ ofio `1e6a64f` |
| — | Public wagered lobbies, gated on verification | ✅ ofio `92d88f3` |
| — | Treasury pinned on the match | ✅ root `75ed1ad`, ofio `228522e` |
| — | Image map layout + ARM64 build | ✅ ofio `551e612` |
| **2** | Branding — name single-sourced to `SITE_NAME` | ✅ ofio `440a4c0` (name is a placeholder) |
| **H6** | The Oracle Cloud box | ✅ both firewalls, Docker 29.8 arm64 |
| — | Domain, Cloudflare DNS, TLS decision | ✅ `warchest-arena.com` live, Origin cert |
| — | GitHub repos | ✅ pushed, public, Actions off |
| — | Deploy path (`deploy/`) | ✅ ofio `d9299a7` |
| — | `scripts/devnet/` for S1–S7 | ✅ root `1ae97bd` |
| **3** | Devnet deploy + live validation (S1–S7) | ✅ deployed; S1–S7 **8/8** on devnet |
| — | Turnstile verified server-side (`/join_verify`) | ✅ ofio `c85cc0c` |
| — | Live site at `warchest-arena.com` | ✅ ofio `a9f7c3a` |
| — | Browser half — two wallets staking a real lobby | **next; needs two funded wallets** |
| **G1** | 1v1 primary, public lobbies secondary | ✅ ofio `4460f9d` |
| **G3** | Wallet login — the browser half of `/auth/wallet` | ✅ ofio `82e8629` |
| **H7** | Ops runbook | after the browser half |

**The duel map pool is shared, not copied.** `core/arena/duelSettings.ts` holds
upstream's ranked 1v1 pool — Australia 40%, Iceland / Asia / EuropeClassic 20%
each — plus the bot count and match clock that go with it. Both
`MapPlaylist.get1v1Config()` (the ranked path) and `HostLobbyModal`'s duel
preset read it, because two copies of a five-map list is the same drift setup as
the wallet prefix that was once declared twice. `ArenaDuelSettings.test.ts`
asserts the ranked path still draws from it, and is mutation-checked.

A duel host configures **nothing**: `HostLobbyModal.renderBody()` returns a
waiting room instead of the settings screen when `duelPreset` is set. The early
return is deliberate — a settings section added later is then absent from duels
by default, which is the safe direction. Both players stake the same amount, so
the map is part of what they paid for; letting whoever clicked first choose it
is an edge bought with nothing.

**Not built:** a site-wide online player count. The lobby broadcast carries
`numClients` per *listed* lobby only, and a started game leaves that list — so
summing it reads near-zero exactly when the most people are playing. An honest
number needs the workers to report their total connected clients through the
`lobbyList` IPC message and the master to sum it into `lobbiesBroadcast`. The
duel picker's per-tier "N waiting" is derived from the broadcast and is
therefore correct as-is; it counts players *waiting*, not playing.

**Not built:** quick-join matchmaking per tier (**G2**) — the part of DamnBruh's
model that pairs strangers automatically rather than listing what hosts have
made. The blocker is written down: `wagerRefusedForVisibility(isPublic)` refuses
a master-created matchmaking lobby unconditionally, because nobody in it staked
and there is no host to create the escrow. A duel queue must therefore pair into
a **private** lobby whose escrow the server creates at pairing time.

**The road to a public devnet site** is `~/.claude/plans/jazzy-moseying-ullman.md`,
which carries the step-by-step. Remaining inputs only you have: devnet SOL from
faucet.solana.com, a Cloudflare Turnstile site key, and running the two
`git push`es (the sandbox refuses them).

---

## Server-side arena components

### `arena/preflight.ts` — verify at boot, not when a host presses the button
`runWagerPreflight()` loads the keypair, confirms the program account exists
**and is executable on this cluster**, and checks the authority's balance against
`MIN_AUTHORITY_LAMPORTS`. `wagerAvailable` on `GET /api/game/:id` reports the
verified answer, so the host UI never advertises an escrow the server cannot create.

**The check that matters most is the rake one.** `ARENA_RAKE_BPS > 0` with no
`TREASURY_TOKEN_ACCOUNT` used to fail at *settlement*, by which point the stakes
are in the vault. At boot it is a one-line refusal.

A misconfiguration is distinguished from a deliberate free-to-play server:
`ARENA_PROGRAM_ID` unset is `off` and logs at info; anything malformed is `broken`
and logs at error, and `/wager` returns the reason so it is diagnosable without a
log dive.

### `arena/devBypass.ts` — opt-in *and* cluster-gated
- **`ARENA_DEV_BYPASS=true` is necessary but not sufficient.** `resolveDevBypass()`
  also asks the cluster for its **genesis hash** and refuses mainnet-beta. The URL
  proves nothing — a provider endpoint need not contain "devnet", a proxy can hide
  it, and a typo'd variable pointing at mainnet reads as ordinary text.
- **Everything fails closed.** Not-requested, mainnet, unreachable RPC and
  never-resolved all land on the strict path. This costs nothing in production:
  the check only runs when the bypass was requested. That is why it is *not* a
  refuse-to-boot check — that would trade real availability risk for no safety.
- **Unknown genesis is allowed on purpose.** `solana-test-validator` mints a fresh
  one every start.
- **The client is told the resolved answer** via `BOOTSTRAP_CONFIG` →
  `ClientEnv.arenaDevBypass()`, not left to infer it. A dev client that assumed
  dev-implies-bypass would prompt the wallet and then have the signature rejected.
- **Runs in both the master and every worker** — module state is per-process, and
  the master renders the app shell.

### `arena/sweeper.ts` — recovery from chain state alone (H2)
`matchRegistry` is a module-level `Map` inside each **worker**. A crash, redeploy
or OOM drops every live wager. The sweeper recovers them from chain state alone:
`MatchAccount` records `authority`, `vault`, `players[]`, `stakes[]`, `status` and
`created_at`, so `getProgramAccounts` filtered on the authority enumerates every
escrow this server ever created with **no server-side persistence**. That is
exactly why it survives the thing that destroyed the registry: it never reads it.

- **Master-only, and that is load-bearing.** N workers sweeping means N concurrent
  `cancel_match` transactions per orphan — one succeeds, the rest pay a fee to be
  rejected. An `inFlight` guard keeps a slow sweep from overlapping the next tick.
- **`InProgress` reuses `MATCH_TIMEOUT_SECS`** — the deadline `cancel_match`
  enforces itself. A shorter sweeper-side number would only submit doomed transactions.
- **The `Open` window is the dangerous one.** The program accepts a cancel on an
  `Open` match at *any* age, so the constant is the only thing stopping the sweeper
  refunding a lobby that is still filling. **2 h would be wrong** — a private lobby
  with no armed start timer sits in `Lobby` phase for the full `maxGameDuration` of
  3 h. It is `MAX_GAME_DURATION_MS + 1 h`, past which `end()` has already refunded
  the lobby itself; the extra hour stops the sweeper racing that.
- **`MAX_GAME_DURATION_MS` lives in `core/Schemas.ts`** so the window is *derived*
  rather than hand-copied. Two copies of "3 hours" is exactly that drift.
- **One status per query** — `getProgramAccounts` AND-s its filters and offers no
  OR. Four queries in two passes: `Open`/`InProgress` orphan scan,
  `Settled`/`Cancelled` rent reclaim.
- **Errors are isolated per match**, not per sweep: one unrecoverable pot must not
  strand every other one behind it.
- `cancelAndRefund()` takes chain state and nothing else, so both callers share one
  implementation of the `players[]`-order pairing `cancel_match` requires.

### `arena/stakeMint.ts` — the staking token, resolved at boot
Shaped after `devBypass.ts`, **not** folded into `preflight.ts`'s `Preflight`
union — that is a verdict type whose return value is discarded at both call sites,
so widening it would quietly make it load-bearing where nobody reads it. A lazily
self-resolving accessor would put an `await` back on the request path; a
module-scope memo would re-create the master/worker env trap. So env is read
*inside* `resolveStakeMint()`, and `stakeMint()` reads null until it succeeds.

Refused at boot, and why each matters:

- **Not owned by the legacy SPL Token program.** The arena pins
  `Program<'info, Token>`, so a **Token-2022 mint can never be escrowed**. It also
  means transfer-fee and transfer-hook extensions cannot apply here — worth writing
  down so nobody re-derives it as a risk. Mutation-checked.
- **Uninitialized.** An uninitialized 82-byte account decodes as `decimals = 0`,
  silently turning every tier into 1/5/25 *base units*.
- **More than 9 decimals.** `25 * 10^18` overflows a u64 and `u64LE()` throws inside
  `buildCreateMatchIx` — a **502 on a live lobby**. The arithmetic ceiling is 17; 9
  is deliberately stricter (SOL is 9, USDC is 6). Raising it past 17 is a
  correctness bug, not a policy change.
- **A freeze authority is warned about, not refused.** One mint for the whole
  deployment turns a per-lobby risk into a global one: a frozen vault or player
  token account fails **both** `settle_match` and `cancel_match`, and H3's timeout
  does not help because it is the transfer itself that fails. Operator's call.

`TREASURY_TOKEN_ACCOUNT` is checked here for the same mint. Mutation-checked.

**Amounts are formatted everywhere.** `formatStake()` does BigInt string surgery
and **never touches `Number`** — `entryFee` crosses the wire as a string precisely
because a u64 loses precision above 2^53. A prompt reading `5000000` where the host
chose "5" is how someone stakes the wrong amount believing they checked.

`WagerConfig` records `mint`, `decimals`, `symbol` and `programId` **per match**,
which makes `toWagerInfo()` a pure function of the config rather than a reader of
current global state. Do not "simplify" `WagerConfig.mint` to a `stakeMint()` call
— `verifyOnchainMembership` compares the on-chain match's mint against that value,
so an operator who repointed the token would kick every player of every live match.

### Fixed stake tiers — 1 / 5 / 25, one operator-set token

Hosts pick a **tier**, not an amount or a mint. The mechanism is chosen for a
security property:

> The server derives `entry_fee` from the tier. The client never sends an amount.
> So an off-tier stake is not *rejected*, it is **unrepresentable**.

Same reasoning as gating a wagered start on `InProgress` rather than a seat count:
a check that cannot drift from the rule it enforces. `POST /api/game/:id/wager`
takes `{ tier, maxPlayers }`; `mint` and `entryFee` are gone from the wire.

- **`STAKE_TIERS` lives in `core/arena/stakeTiers.ts`, which imports nothing** —
  not even Zod, because the root bankrun suite reaches into it. `Worker.ts` builds
  its validation *from* the array rather than hand-writing a literal union.
- **A drifted client copy cannot create a wrong escrow.** It can only offer a tier
  the server refuses. The shared list is for rendering; the derivation has one
  implementation.
- **`ARENA_MAX_ENTRY_FEE` filters the tiers** rather than getting a parallel knob.
  Its meaning depends on the mint's decimals, so `stakeMint.ts` logs which tiers it
  took the cap to mean. A cap suppressing *every* tier is refused at boot.
- **`rakeBps` is never a host input** — it comes from `ARENA_RAKE_BPS` server-side.
- **Tier 25 at 16 players is a 400-token pot**, and `maxPlayers` is host-chosen. The
  cap is the only ceiling on what one lobby can stake. Worth setting.
- **`wagerOptions` is separate from `wager` on `GET /api/game/:id`** because the
  host picks a tier *before* any escrow exists.

### Public wagered lobbies — the flag is not a boolean

**`ARENA_PUBLIC_WAGER_LOBBIES=true` is a request, not a decision.** The server
honours it only after a replay verification has actually succeeded on that
process — `arena/replayProbe.ts` plays a short match on the smallest shipped map
and re-derives it through the **production** verifier. Same posture as
`resolveDevBypass()`: the env var records an intention, what matters is a fact
about this deployment.

The fact is narrow and real. A verification that cannot run — map data missing
from the image, the worker thread unable to load its own TypeScript — makes every
wagered match refuse to settle and refund on the 24h timeout. Neither failure is
visible to tsc, and neither surfaces until a match ends. A public queue on top of
that recruits strangers into lobbies that can only ever refund.

- **Resolved per worker, not in the master.** The gate is read by `/listing` and
  `/wager`, which only workers serve, and verification runs in the worker owning
  the game — so a per-worker proof is the real thing.
- **The two endpoint refusals are one pair, tested together.** A host reaches a
  listed wagered lobby two ways — wager then list, or list then wager — so a gate
  on one is an ordering puzzle, not a restriction. `listingRefusedForWager()` and
  `wagerRefusedForVisibility()` live side by side in `publicLobbies.ts`. **They
  must stay a pair.** A matchmaking lobby (`isPublic()`) stays unwagerable whatever
  the gate says: nobody in it staked and there is no host to create the escrow.
- **`PublicGameInfoSchema` carries a summary, not a `WagerInfo`** — no `matchPDA`,
  `vault`, `programId` or `rpcUrl`. That payload reaches every browser watching the
  lobby list, repeatedly, for lobbies nobody has clicked.
- **`winnerPayout()` is shared** between the lobby card and the stake prompt. A card
  promising more than the prompt charges is not reported as a bug — people just stop
  trusting the number.
- **The card renders the amount as data, outside the translated string**, so a
  missing translation cannot hide what a seat costs.
- **Joins from the browser route through the same stake gate as a pasted lobby id** —
  `JoinLobbyModal` dispatches `join-lobby` with `source: "private"` for both, which
  is what `Main.resolveWagerJoin` keys on. Worth not breaking.
- **The stake prompt states the refund/forfeit boundary, above the stake button.**
  Leaving before the last seat stakes is free (escrow `Open`, `end()`'s not-started
  branch refunds); leaving after it forfeits (`cancel_match` refuses `InProgress`
  for 24 h). Same action, opposite outcome, and the switch is the *other* player
  staking — which that screen cannot show. **Do not add a time estimate to it:**
  the same prompt serves a listed duel (cancelled ~5 min after listing) and a
  hand-made private wagered lobby with no armed timer (up to `MAX_GAME_DURATION_MS`),
  so any number is a promise broken for one of them. Mutation-checked on position —
  a disclaimer under the button is one nobody reads before deciding.

*Mutation-checked twice:* drop the probe requirement and `REFUSES when the server
cannot actually verify` fails; drop the gate from `listingRefusedForWager` and
`refuses both orders while the gate is off` fails.

### H3 — the `InProgress` escape hatch
`cancel_match` also accepts `InProgress` once `MATCH_TIMEOUT_SECS` (24 h) has
elapsed since `created_at`. Without it, a lobby that filled and then lost its
server had **no on-chain path out at all**.

- **The status gate lives in the handler, not the `Accounts` struct**, because the
  `InProgress` case is conditional on the clock. Anything editing that struct must
  leave the `require!` in place — removing it lets the authority cancel a live
  match mid-play. Mutation-tested.
- **This does not widen who is trusted.** The authority already signs the digest
  that decides the payout; the timeout only adds a delayed refund to the players.
- **24 h is deliberately far longer than any match**, so it can never race a
  slow-but-live settlement. `settle_match` keeps working past the deadline.
- `MATCH_TIMEOUT_SECS` is `#[constant]`, so it reaches the IDL and the TypeScript
  mirror is **diffed against it**. It is the only arena constant with a real IDL
  pin — `MAX_PLAYERS` is pinned indirectly by `MATCH_ACCOUNT_SIZE` and the field
  offsets, `MAX_RAKE_BPS` by `create_match`'s own rejection.

---

## Client and settlement constraints that are easy to break

These were established while building the integration and are still live:

- **Standings come from `fetchMatchAccount(...).players`**, trimmed to
  `player_count` and in join order — the order `settle_match`'s `scores` is indexed
  against. Not from any server-side ordering.
- **`verifyOnchainMembership` proves payment by presence in `players[]`**, because
  the program writes it only after `token::transfer`. The old check merely asserted
  that *some* confirmed transaction touched the match PDA — which any transaction
  naming the account satisfies, including one that failed to stake or one somebody
  else sent. `ClientJoinMessage.onchainTxSig` is still sent but is **audit-only**.
- **It retries 5× with exponential backoff and jitter** (~300/600/1200/2400 ms,
  ±20%). The joining browser may be on a different RPC
  (`ARENA_PUBLIC_RPC_URL`) than the server, and a node briefly behind would
  otherwise kick a player who genuinely paid.
- **A transport failure is transient; only `MatchAccountDecodeError` is
  permanent.** These were once one catch, so a single 429 returned "not a
  member" *without the retry loop running at all* — kicking a paying player.
  Found on the first real devnet run, where `api.devnet.solana.com`
  rate-limited repeatedly. Mutation-checked in
  `ArenaMembershipRetry.test.ts`; collapsing the catches fails two tests.
- **`MembershipCheck.failure` separates "could not check" from "did not pay".**
  Exhaustion still refuses — admitting an unverified wallet into a wagered match
  is never acceptable — but `rpc-unavailable` makes a run of these read as an
  outage rather than fraud, and `Worker.ts` tells the player to retry instead of
  telling them their fee was not confirmed.
- **The jitter is load-bearing.** Every player in a filling lobby joins within
  seconds of the others, so a fixed schedule makes them retry in lockstep
  against an already rate-limited endpoint.
- **Public RPC endpoints rate-limit this hard.** `api.devnet.solana.com` 429s
  under the load of a single test run. Use a dedicated endpoint for
  `SOLANA_RPC_URL` before going public, and keep `ARENA_PUBLIC_RPC_URL`
  keyless — it is served to every browser.
- **`decodeMatchAccount` validates owner, discriminator, length, `MatchStatus`
  range and `player_count <= max_players` before trusting a field.** The owner
  check is load-bearing: without it any account of the right length decodes into a
  plausible match.
- **`ensureTokenAccount()` runs in its own transaction**, so it cannot push the
  settle tx over the size limit or disturb the ed25519-at-index-0 requirement.
- **The digest preimage is built by `settleMessagePreimage()`** (pure,
  browser-safe); the caller hashes it, because sha256 has no synchronous
  cross-realm implementation. A wrong preimage produces a perfectly valid signature
  the program rejects, and the pot stays locked.
- **The ed25519 instruction uses web3.js's `Ed25519Program`**, not the hand-rolled
  test helper. Payload byte order differs, which does not matter — the program reads
  the header offsets — and the canonical builder is less likely to drift.
- **The client stake gate is dynamically imported** in `Main.ts`. Static-importing
  it put `@solana/web3.js` — 294 kB / 86 kB gzipped — in the main chunk for every
  player. Keep it lazy; verify with `npx vite build` that `wagerJoinFlow-*.js` is
  still a separate chunk.
- **The host must stake too.** `create_match` does not enrol the authority as a
  player, so `HostLobbyModal.handleAttachWager` re-dispatches `join-lobby` on
  success. `POST /wager` correspondingly rejects a lobby with more than one client
  connected (`wager_lobby_not_empty`) — anyone who joined before the escrow existed
  got in unstaked and cannot be made to stake retroactively.
- **`Main.ts` runs the gate before tearing down the existing lobby handle**, so
  backing out of the stake prompt does not leave the player disconnected.
- **The nonce seed is `sha256(gameId)[0..8]` read LE**, so a match PDA is
  re-derivable from the game id alone — no counter to persist.
- **`arena/serverKeypair.ts` is the single place the authority key is read.** Do
  not add a second loader.
- **Wallet-signature nonce and message format live in `core/arena/authMessage.ts`**,
  shared by both ends. The prefix used to be declared twice with a "must match
  server" comment — the classic silent-drift setup, whose only symptom is an
  unexplained invalid-signature disconnect. `walletLoginMessage()` sits beside
  `authMessage()` with a **distinct prefix**, so a captured match signature can
  never be replayed as a login.
- **Settlement failure paths leave the pot in escrow rather than guessing**:
  unknown winner, team win (the program pays exactly one wallet), a winner who did
  not stake. Each logs; none submits.

---

## Auth service (`OpenFrontIO/src/auth/`)

This fork's replacement for upstream's **closed-source** JWT issuer, which is not
in the repo — without it the site could only run as `GAME_ENV=dev`. Stateless,
its own process and container at `api.$DOMAIN`. **Full detail in
`OpenFrontIO/docs/Auth.md`.** The rules that bite:

- **No database, by design.** Every field `/users/@me` returns is derived from the
  session or is an operator constant. A wallet's identity is *derived from the
  address*, so the same wallet is the same player everywhere with nothing stored.
  **The cost:** no revocation list — an issued access token stays valid for up to
  its 15-minute life.
- **Token kinds are separated by `aud`, not a hand-written check** — access →
  `$DOMAIN`, refresh → `<issuer>/auth/refresh`, challenge → `<issuer>/auth/wallet`.
  `jwtVerify` enforces the audience itself, so a refresh cookie replayed as a
  bearer token fails *verification* rather than depending on a guard.
- **A cookieless `/auth/refresh` mints a new guest rather than failing.** It is the
  browser's only guest path, so a 401 would leave a first-time visitor with no
  session and make `Auth.ts` clear their settings. It is also why that route is
  rate limited: each cookieless call creates an identity.
- **`iss` is pinned, not configured.** `AuthEnv.issuer()`, `ServerEnv.jwtIssuer()`
  and `ClientEnv.jwtIssuer()` each *compute* `https://api.$DOMAIN` (or
  `http://localhost:8787`) and reject anything else. `AUTH_PORT` deliberately does
  not feed the issuer.
- **The signing key is never auto-generated for a configured path.** A container
  minting one per start would invalidate every session on each deploy, and the game
  server caches the first JWKS response for the life of its process. Outside dev
  the service **refuses to boot** without `AUTH_SIGNING_KEY_PATH`.
- **`src/auth/` must not import `src/server/`.** `ServerEnv` throws for vars the
  auth service has no business setting, and `server/Logger.ts` wires OpenTelemetry
  at import time — either would make it unable to boot alone. It shares only
  `src/core/`.
- **Wallet login is the sign-in, and it is menu-only.** `client/arena/walletLogin.ts`
  is the browser half of `/auth/wallet`; it replaced the inherited Discord,
  Google and email buttons, which all navigate to endpoints this service 404s.
  Signing in swaps `sub`, hence the persistentID, hence any `walletRegistry`
  binding and any in-flight `jti`-bound match signature — so it **refuses**
  while `document.body` has `in-game` or the `.arena-wager-overlay` stake prompt
  is open, rather than trying to reconcile. At the menu nothing is bound yet.
  Staking still needs no login; the arena verifies wallet ownership per match.
- **The login message is built in the browser, never fetched.**
  `/auth/wallet/challenge` returns the nonce *without* the signable text on
  purpose, so a spoofed service cannot get a wallet to sign arbitrary bytes.
  Both ends are pinned: `AuthService.test.ts` that a match signature is refused
  as a login, `ArenaWalletLogin.test.ts` that the client never produces one.
  Both mutation-checked. **Do not unify the two prefixes.**
- **`AuthService.test.ts` runs under `// @vitest-environment node`.** The repo
  default is jsdom, whose `TextEncoder` is a different realm — jose and tweetnacl
  both type-check with `instanceof`, so every sign() fails there.

---

## Local development

### Testing the wager loop — read this first
- **The dev bypass on the on-chain membership check is separate and still active.**
  `Worker.ts` skips `verifyOnchainMembership` in dev, so a dev player joins whether
  or not they staked. Since that read also feeds the start-gate's cached fill state,
  an unstaked dev lobby **refuses to start at all** (`wager_lobby_not_full`). To
  exercise a payout locally, every seat has to genuinely `join_match`.
- **Wagering needs a deployed program**, a funded `SERVER_KEYPAIR_PATH`, and
  `ARENA_PROGRAM_ID` set. With it empty the host UI hides the stake control and
  every lobby stays free — the correct default, not a failure.
- **`npm run dev:auth` gets you a real `jti`** so the wallet signature binds to a
  session rather than falling back to `devAuthNonce()`. `npm run dev` is unchanged.
- **Staking cannot be exercised headlessly** — `join_match` is submitted by the
  *browser*, so it needs a wallet extension. Everything up to the prompt works.

### Standing the whole thing up (done once, works)

`docs/surfpool.md` covers the validator; this is the rest.

```bash
# WSL: validator, then deploy at the DECLARED id
surfpool start --offline --no-deploy --no-tui --port 8899
solana config set --url http://127.0.0.1:8899
solana airdrop 100
solana program deploy --program-id target/deploy/arena-keypair.json target/deploy/arena.so

# WSL: the match authority (NOT the deployer) and a token to stake
solana-keygen new --no-bip39-passphrase -o OpenFrontIO/.keys/arena-authority.json
solana airdrop 50 "$(solana address -k OpenFrontIO/.keys/arena-authority.json)"
spl-token create-token --decimals 6
```

Then `OpenFrontIO/.env` — `SOLANA_RPC_URL` and `ARENA_PUBLIC_RPC_URL` at
`http://127.0.0.1:8899`, `ARENA_PROGRAM_ID` at the deployed id,
`SERVER_KEYPAIR_PATH=.keys/arena-authority.json`, `ARENA_RAKE_BPS=0` — and
`npm run dev`. Boot should say `wagering enabled and verified` **three times**
(master plus both workers) then `[arena/sweeper] recovering orphaned escrows`.
Fewer than three, or no sweeper line, means the master disagrees with its workers
— see the env trap below.

`.keys/` and `.env*` are gitignored. Keep it that way.

### ⚠️ The master/worker env trap — will recur

`Server.ts` calls `dotenv.config()` **after** its imports, and ESM evaluates the
entire module graph before any statement in the entry file runs. So any
module-level `process.env` read in that graph sees an **empty** environment in the
master — while forked workers, handed an already-populated `process.env` by
`cluster.fork()`, read the right value.

`arena/rpcClient.ts` had exactly one, and the master therefore pointed at
**devnet** while its workers pointed at the configured RPC. The symptom read as a
flake: the master reporting the program "not deployed on this cluster", both
workers verifying the same program 1.5 s later. Preflight fails closed, so the
master silently never started the sweeper — the one recovery mechanism meant to
survive a crash, disabled by an import order.

Fixed by making the connection **lazy and memoized** (`getConnection()`),
deliberately *not* by moving `dotenv` above the other imports — prettier reorders
imports in this repo, so an ordering-dependent fix would be one `npm run format`
away from coming back. `ArenaRpcClient.test.ts` pins the timing and is
mutation-checked.

**Any new module-level `process.env` read under `src/server/` inherits this bug.**
Read env inside a function, as `ServerEnv` already does.

**`GAME_ENV` is the same trap, one level worse, and it is not fixable in code.**
`ServerEnv.ts`'s `gameEnv` is a **static field initializer**, so it runs at
module evaluation — earlier than any function call, and long before
`dotenv.config()`. So `GAME_ENV` **cannot come from a `.env` file the app parses
itself**; it must reach the process as a real environment variable
(`docker run --env-file` does, dotenv does not). Missing, the process dies at
import with a bare `unsupported game env: undefined` and **no
`Failed to start server:` line**, because `main().catch()` never runs. Invisible
under vitest, where `vite.config.ts` textually substitutes `"dev"` in.

---

## Deploying — `deploy/`, and the health check that lies

`deploy/warchest.sh`, `deploy/Caddyfile`, `deploy/warchest.env.example`.
**All four of upstream's scripts are unusable and are not patched** — the
reasons are in `warchest.sh`'s header and `deploy/README.md`.

### ⚠️ `/api/health` returning 200 does not mean the site is up

It goes green as soon as the workers register, and **stays green while every
`GET /` returns 500** — `RenderHtml.ts` reads `TURNSTILE_SITE_KEY`,
`GIT_COMMIT`, `DOMAIN` and `NUM_WORKERS` while building its EJS data object,
long after the health route is serving. A monitor watching only `/api/health`
reports a healthy site nobody can load.

**Any smoke test must fetch `/` and assert markup.** `warchest.sh` does both.
Connection-refused in the first seconds is *not* a failure: the master binds
`:3000` only after `runWagerPreflight()`, which makes live RPC round-trips.

### The boot-log counts are the real arena check

`wagering enabled and verified` must appear **`NUM_WORKERS + 1`** times, and
`[arena/sweeper] recovering orphaned escrows` **exactly once**. Workers verified
with no sweeper line is the master/worker env trap above, and its consequence is
exact: the only crash-recovery path for live escrows is silently disabled.
`warchest.sh` asserts both and refuses the deploy otherwise.

### ⚠️ `curl … | grep -q` cannot work in this script — and fails in the worst direction

`warchest.sh` runs under `set -euo pipefail`. `grep -q` exits the instant it
matches, the writer upstream of it then dies of **SIGPIPE**, and `pipefail`
reports the whole pipeline as failed. Two checks were built on that shape:

- the **health gate** (`curl / | grep -qi '<html'`) could therefore never pass.
  It rolled back two deploys that had actually succeeded.
- the **dev-bypass check** (`docker logs | grep -q 'arena/devBypass'`) fails only
  when grep *matches* — so it passed silently in precisely the case it exists to
  catch.

Both are fixed by not piping: `serves_markup()` captures the body and
pattern-matches it in the shell, and the log check uses `grep -c … || true` and
compares a count.

**It does not reproduce on a small page**, which is the trap. A response that
fits the 64 KB pipe buffer never triggers SIGPIPE, so a local repro passes.
Measured against the live server the real command was **rc=23 on 5/5 runs** at
151,609 bytes. Any new pipeline added to that script needs the same treatment.

### ⚠️ Two certificates, and the Origin one must not carry the wildcard

`api.` is **DNS-only**, so browsers *and* the game container's own JWKS fetch
reach it directly — and a Cloudflare **Origin** certificate is trusted by
Cloudflare and by nothing else. Serving it there is `SEC_E_UNTRUSTED_ROOT` and
auth stops working entirely: no browser login, no server-side JWKS. The apex
gets away with it only because Cloudflare proxies the apex and presents its own
Universal SSL to the browser, so the Origin cert is seen by Cloudflare alone.

So `api.` gets a real Let's Encrypt certificate that Caddy obtains and renews
itself. That is also why `auto_https` is **`disable_redirects` and not `off`** —
`off` would disable that issuance along with the redirects.

**Dropping `import origin_tls` from the `api.` block is not sufficient.** Caddy
matches certificates out of one **process-wide cache, by SAN**, so an Origin cert
whose SANs include `*.warchest-arena.com` matches `api.` no matter which site
block loaded it. Caddy logs *"skipping automatic certificate management because
one or more matching certificates are already loaded"* and serves the untrusted
cert regardless. There is no per-site scoping and no `force_automate` in Caddy
2.11. **Issue the Cloudflare Origin certificate for the apex and `www` only** —
never the wildcard.

### Fixed by topology, not by patching

`trust proxy` is **correct as shipped** for this deployment: the apex is
Cloudflare-proxied, so the game is Cloudflare → Caddy → nginx → Express = 3 hops
(`Master.ts`, `Worker.ts` set 3), and `api.` is DNS-only, so auth is
Caddy → Express = 1 hop (`routes.ts` sets 1). **Grey-clouding the apex would
require dropping the game's value to 2** — otherwise `req.ip` takes a
client-supplied `X-Forwarded-For` entry and the per-IP rate limiter becomes
trivially bypassable.

### Other rules that are load-bearing

- **Build natively on the target box, never `--platform`.** esbuild picks its
  platform binary from the *build host's* arch.
- **`--restart=always` unconditionally.** `update.sh` sets `no` unless
  `SUBDOMAIN=main`; a wagering server that stays down leaves live escrows with
  nothing to settle or refund them.
- **Secrets are read-only bind mounts at `/run/secrets/`**, never env vars, and
  the keypair must be readable by **uid 1000** — a `600` root-owned file mounts
  fine and is then unreadable by the container's `node` user.
- **uid 1000 is not necessarily the login user, and here it is not.** On this
  Oracle Ubuntu image `ubuntu` is **1001**; uid 1000 is `opc`. So
  `chown ubuntu:ubuntu` yields a key the container cannot read while looking
  entirely correct in `ls -l`. Generate as root and `chown 1000:1000` **by
  number**. `warchest.sh`'s `check_secret()` prints the numeric owner for
  exactly this reason — three separate docs claimed uid 1000 was `ubuntu` and
  all three were wrong.
- **Never `docker image prune -a -f`.** It runs box-wide and deletes the build
  cache and the rollback target.

---

## Hosting this fork — three licences, none optional

Details in `OpenFrontIO/docs/branding.md`. The short version, because each of
these is easy to silently undo:

- **`proprietary/` must stay empty.** It held OpenFront's wordmark, logos,
  favicon, font and music, all *All Rights Reserved*. The directory and build
  plumbing remain so a licensed copy can be restored — but do not restore the
  assets, and **reject any upstream merge that re-adds them**. Nothing breaks
  without them; the font and music failures are already caught.
- **Do not reinstate upstream's analytics.** In a fork, their Google Ads, GA4
  and **Cloudflare Web Analytics** tags report your traffic into their accounts.
  `AppShellBranding.test.ts` asserts their absence precisely because
  `index.html` is a merge target. The Cloudflare beacon
  (`cloudflareinsights.com`, token `03d93e6f…`) survived the first sweep because
  it sits further down the file under its own heading — it is now covered too,
  and mutation-checked.
- **AGPL v3 §13 is the load-bearing one.** Offering a modified version over a
  network obliges you to offer its users *that version's* source. The mechanism is
  the footer link, driven by `SOURCE_REPO_URL`. Unset means the footer points at
  upstream, which is only honest for an unmodified build.
- **§7 cuts both ways:** preserve copyright notices (`CREDITS.md`, the upstream
  links, `proprietary/LICENSE` stay), but do not present this as official
  OpenFront — the name, logo and page title must change.
- **The site name is `SITE_NAME`, and the page title is NOT a translated string.**
  It used to be `<title data-i18n="main.title">`, and ~40 Crowdin-managed locale
  files each hardcode upstream's name — only `en.json` is editable here, so a
  rename through the translation system would have left the fork calling itself
  OpenFront in every language but English. That is the §7 misrepresentation, not
  a cosmetic slip. The title now renders from `siteName`, the variable `og:title`
  already used, so no new EJS variable was introduced. `main.title` is gone from
  `en.json` (the repo refuses unused keys); **do not re-add it or re-wire the
  title through it.** *Mutation-checked:* restore the `data-i18n` title and two
  `AppShellBranding.test.ts` cases fail.
- **`Warchest Arena` is a placeholder**, pending the domain. Logo and favicon are
  still the neutral mark — that art should follow the final name.

**`index.html` has two renderers, which is how this bit us.** `RenderHtml.ts`
renders it in production; **`vite.config.ts` renders it for `npm run dev`** from
its own hand-maintained copy of the same data. Variables added to one and not the
other produced a **500 for every dev page load** until someone tried to look at
the UI. It is EJS rendered at request time, so a missing variable is a production
`ReferenceError` that tsc and lint cannot see. `AppShellBranding.test.ts` is the
only thing that renders the template and also asserts every EJS variable has a key
in `vite.config.ts`. **A new template variable needs adding in both places.**

`arenaDevBypass` is deliberately the *requested* value in the vite config rather
than the resolved one — `resolveDevBypass()` asks the cluster for its genesis
hash, which a config file cannot do. It cannot leak past dev: `createHtmlPlugin`
is only registered when `!isProduction`.

---

## Settled — do not re-investigate

Each of these was decided after real cost. The reasoning is above or in git; this
list exists so nobody re-opens the question from scratch.

- **The root-level agar.io engine was deleted** for OpenFrontIO. Recoverable at
  `d5c610a`. **Do not resurrect it.**
- **Anchor 0.30.1 / Solana 1.18 cannot build this**, and pinning transitive deps
  does not converge. Do not downgrade.
- **The duplicate `OpenFrontIO/programs/` copy is gone**; the root program is
  canonical. That copy's `settle_match` did no signature verification at all.
- **`pot = vault.amount` is correct.** Do not "fix" it to `sum(stakes)`.
- **`ArenaError` is append-only.** Anchor numbers variants positionally from 6000,
  so inserting one silently renumbers every error after it — including the codes
  TypeScript matches on. Current tail: `MatchNotTimedOut` 6010,
  `WinnerTokenOwnerMismatch` 6011, `InvalidRefundAccount` 6012, `MathOverflow`
  6013, `VaultNotEmpty` 6014, `MatchNotTerminal` 6015, `InvalidTreasury` 6016,
  `TreasuryMintMismatch` 6017, `TreasuryRequired` 6018.
- **`declare_id!` is `4CGRLB5WJ4LK4nqwhzN5uhU78cakuHzG5wfrUZrQ2G64`** in both
  `lib.rs` and `Anchor.toml`. bankrun never notices a mismatch; a real deploy fails
  every instruction with `DeclaredProgramIdMismatch`.
- **The vendored `solana-dev` skill's stack advice is deliberately not followed.**
  `.claude/skills/solana-dev/` is a pinned copy of
  [solana-foundation/solana-dev-skill](https://github.com/solana-foundation/solana-dev-skill)
  v2.4.0 (MIT), commit `718f7cd`; `VENDOR.md` records provenance. It is Kit-first
  and Anchor-1.1-first — read it for security, concepts and Surfpool, not as a
  mandate to migrate. We stay on Anchor 0.31.1 and web3.js v1; `arenaProgram.ts` is
  hand-rolled precisely to avoid a large client dep that ships to the browser. Its
  `W011` rule (validate owner, length and discriminator before deserializing) is
  already what `decodeMatchAccount` does.
- **`.mcp.json`** adds the Solana MCP server at project scope, for Anchor
  constraint and error questions. Treat its answers as documentation, not as
  authority over this file.

---

## Conventions
- Commits: conventional commits (`feat(arena):`, `fix(program):`, …).
- Inside `OpenFrontIO/`, mark every edit to a pre-existing upstream file with an
  `// [ARENA]` comment — see `OpenFrontIO/docs/upstream-map.md`. This keeps
  upstream merges tractable.
- **Checks before declaring done:**
  - Program, from WSL: `anchor build && anchor test --skip-deploy --skip-local-validator`
  - Changing `programs/arena/` means re-running `anchor build` **before** the tests —
    `tests/arenaProgram.ts` diffs against the generated IDL, so a stale one hides drift.
  - Optionally `npm run test:surfpool` against a local Surfpool with the program
    deployed — the only way to reach `MATCH_TIMEOUT_SECS`, and the only check that
    the program *deploys*. Worth running after any account-layout or instruction-arg
    change. See `docs/surfpool.md`.
  - `npm run test:devnet` (`scripts/devnet/`) asserts S1–S7 against a really-
    deployed program on **devnet**, which is the only place RPC latency, real
    confirmation ordering and blockhash expiry exist. It cannot reach the 24 h
    `InProgress` timeout — that needs Surfpool's `surfnet_timeTravel` cheatcode —
    so the two suites are complements, not alternatives. See
    `scripts/devnet/README.md`.
  - **Root `npm` scripts must run from WSL.** `node_modules` is installed there
    (`solana-bankrun` is a native NAPI module), so the `.bin` shims are Linux ones
    and Windows fails with `'ts-mocha' is not recognized`.
  - Game, from `OpenFrontIO/`: `npx tsc --noEmit`, `npm run lint`, **and `npm test`**
    (`vitest run && vitest run tests/server`). **Do not skip the vitest run** —
    `en.json` additions are checked for **nested** key ordering by
    `tests/EnJsonSorted.test.ts`, which tsc and lint know nothing about.
  - `OpenFrontIO` tsc must be **clean — zero errors**. Any error means you
    introduced it. `npm run lint` likewise. Run `npx prettier --write` on changed
    files too; lint does not cover formatting, and the repo's prettier config
    reorders imports.
- **Security-relevant program changes need a mutation test**, not just a passing
  one. Break the check on purpose, rebuild, and confirm the test fails. The four
  that exist are named in the security invariants section.
- The `run-openfront` skill in `OpenFrontIO/.claude/skills/` targets headless
  Ubuntu + Playwright and does not apply on this Windows machine. Use the human
  path: `npm run dev`, then open `http://localhost:9000`.

## Environment Variables
`OpenFrontIO/.env` (add to `example.env` as they land).

**Required for a non-dev boot, or the process dies:** `GAME_ENV` (throws at
module import — and **cannot come from a `.env` file**, see the env trap),
`NUM_WORKERS`, `GIT_COMMIT` (a Docker build arg), `TURNSTILE_SITE_KEY`, `DOMAIN`.

**`GIT_COMMIT`, `TURNSTILE_SITE_KEY`, `DOMAIN` and `NUM_WORKERS` do not stop the
boot — they 500 every `GET /` while `/api/health` stays 200.** `RenderHtml.ts`
reads all four while building its EJS data object. That is why a smoke test must
fetch `/`.

`GAME_ENV`, `NUM_WORKERS` and `TURNSTILE_SITE_KEY` were undocumented until
ofio `d9299a7`; they are now in `example.env` with the traps written down.

**Turnstile has two halves and needs both.** `TURNSTILE_SITE_KEY` (game server,
public, rendered into every page) and **`TURNSTILE_SECRET_KEY` (auth service,
secret)**. The widget always rendered, and `JoinVerify.ts` always POSTed to
`api.$DOMAIN/join_verify` — but that endpoint lived in upstream's **closed** API,
so it 404'd and every join fell open. `src/auth/turnstile.ts` is the missing
half.

**With no secret the route is not registered at all**, so it 404s and the old
fail-open behaviour is unchanged. That is deliberate: a route that exists and
approves everything looks like bot protection while being none. The auth service
says which it is at boot.

**`/join_verify` does not moderate names.** Upstream's worker ran an LLM check
and could return a rewritten username; this fork passes names through unchanged.
The game server already screens locally via `Censor.ts` — its documented
fail-open path — so nothing regresses, but an `approved` here does not mean a
name was vetted.

**A null token skips siteverify, and that is the contract, not a hole.** A
Turnstile token is single-use, so an already-admitted player reconnecting has
none left. `planJoinVerify()` on the game server is what guarantees a *first*
join never arrives with a null token; forwarding one would be a full bypass.
*Mutation-checked* along with the hostname pin and the reject path.

**`NUM_WORKERS` is a pick-once decision.** Game ids shard to workers via
`simpleHash(gameID) % NUM_WORKERS`, so changing it re-shards every id and a live
match's URL routes to a worker that has never heard of it.

### Arena
- `SOLANA_RPC_URL` — RPC endpoint.
- `SERVER_KEYPAIR_PATH` — server ed25519 keypair; **must be the same keypair** used
  as match `authority` in `create_match` and as signer in `settle_match`. Loaded in
  exactly one place, `arena/serverKeypair.ts`.
- `ARENA_PROGRAM_ID` — deployed program id. **Leaving it empty disables wagering
  entirely**: the host UI hides the stake control and every lobby stays free.
- `ARENA_PUBLIC_RPC_URL` — RPC endpoint handed to **joining browsers**, which submit
  their own `join_match`. Falls back to `SOLANA_RPC_URL`; set it separately if that
  one embeds an API key, because this value is served to every player.
- `ARENA_STAKE_MINT` — the SPL token every stake is denominated in. **Required once
  `ARENA_PROGRAM_ID` is set.** Verified at boot: must exist, be owned by the
  **legacy** Token program, be initialized, and declare at most 9 decimals.
- `ARENA_STAKE_SYMBOL` — display-only ticker, max 12 of `[A-Za-z0-9._-]`. An
  operator claim rather than on-chain metadata, which is why the mint address stays
  visible beside it in the stake prompt.
- `ARENA_RAKE_BPS` — house cut, 0..1000. Operator-set, never host-set.
- `TREASURY_TOKEN_ACCOUNT` — rake destination (needed once rake > 0). Read at
  **`create_match`** and written onto the match, so `settle_match` refuses any other
  destination. Changing it affects only matches created afterwards — live escrows
  keep paying the treasury they were made with, which is the point.
- `ARENA_MAX_ENTRY_FEE` — ceiling on one seat's stake, in token base units. Empty
  means no ceiling. Also **filters which of the 1/5/25 tiers are offered**, and its
  meaning depends on the mint's decimals — the boot log says which it took.
- `ARENA_PUBLIC_WAGER_LOBBIES` — whether a wagered lobby may be listed publicly.
  **Default off, and not a plain boolean:** the server honours it only after a
  replay verification has actually succeeded on that worker at boot.
- `ARENA_DEV_BYPASS` — **dev only, default off.** Skips the wallet-signature session
  binding and the on-chain stake check. Only honoured when `GAME_ENV=dev` **and**
  the cluster's genesis hash proves it is not mainnet; refused if the RPC is
  unreachable.
- `ARENA_AUTHORITY_KEYPAIR` — **deploy only**, path to the keypair *on the target
  host*. Bind-mounted read-only; the deploy sets `SERVER_KEYPAIR_PATH` to the
  in-container path itself, because an env var would sit in `docker inspect`, in the
  deploy env file, in `ps`, and in any crash dump. Setting it also forces
  `--restart=always` — a wagering server that stays down after a crash leaves live
  escrows with nothing to settle or refund them.

### Auth
- `AUTH_SIGNING_KEY_PATH` — the auth service's Ed25519 private JWK. **Refuses to
  boot outside dev when unset**; dev generates an ephemeral key. Never auto-created
  for a configured path.
- `AUTH_SIGNING_KEY` — **deploy only**, path to that key on the target host. Setting
  it is also what makes the deploy start an auth container at all.
- `AUTH_PORT` — listen port, default 8787. Does **not** change the issuer, which
  both the game server and the browser compute themselves.
- `AUTH_COOKIE_DOMAIN` / `AUTH_COOKIE_SECURE` — refresh-cookie attributes. Empty
  domain means host-only (`api.$DOMAIN`), the only reader; `Secure` defaults on
  outside dev.
- `AUTH_ALLOW_PUBLIC_LOBBIES` — whether `/users/@me` reports
  `canCreatePublicLobbies`. Listing a *wagered* lobby additionally needs
  `ARENA_PUBLIC_WAGER_LOBBIES` and a verification that passed.
- `TURNSTILE_SECRET_KEY` — the **secret** half of the Turnstile widget, read
  only by the auth service. Empty leaves `POST /join_verify` **unregistered**,
  so it 404s and the game server falls open exactly as before. Setting it is
  what makes the widget mean anything.
- `AUTH_ALLOWED_ORIGINS` — extra origins allowed to send credentialed auth
  requests. `https://$DOMAIN`, its subdomains and dev localhost are allowed without
  listing.

### Site
- `SITE_NAME` — public display name. Drives **both** the browser tab title and
  `og:title`; falls back to `DOMAIN`. It is the only place the name lives, so a
  rename is this one variable plus the logo art.
- `SOURCE_REPO_URL` — where **this** deployment's source lives. Drives the footer
  link. **Unset is an AGPL §13 problem, not a cosmetic one** (see the licensing
  section). The master logs a warning at boot outside dev.
- Existing OpenFront vars (`GAME_ENV`, `API_KEY`, `DOMAIN`, …) — see `example.env`.

**Ops requirement:** the server keypair needs a funded SOL balance to pay rent for
each match's `MatchAccount` and vault ATA (~0.0085 SOL, reclaimable via
`close_match`). Use a devnet faucet for testing.
