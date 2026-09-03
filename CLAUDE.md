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
  (all **five** instructions incl. `cancel_match` and `close_match`, **16** errors,
  and one `#[constant]`), `target/types/arena.ts`.
- `anchor test --skip-deploy --skip-local-validator` — **42 passing, 0 failing.**
  - `tests/arena.ts` (20): happy path, rake math, double-join rejected,
    bad-signature rejected, the six `cancel_match` tests, the four adversarial
    ed25519/authority tests (see the security section below), the refund-account
    pairing test, and four `close_match` tests.
  - `tests/arenaProgram.ts` (22): pins the hand-rolled program bindings
    (`OpenFrontIO/src/core/arena/arenaProgram.ts`) — see below.
- `npm run test:surfpool` (3 more, **not** part of `anchor test`) runs against a
  really-deployed program on a local Surfpool validator, because bankrun cannot
  reach a 24-hour deadline. See `docs/surfpool.md`.

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
- **`settle_match` requires `.signers([authority])`.** This used to say the
  opposite — it declared no `Signer` at all and the ed25519 prelude was the whole
  authorisation, which is what made the prelude bug below a total break. It now
  takes the authority as a signer *as well as* an attester. The suite's `serverKp`
  is a raw `nacl.sign.keyPair()`, so wrap it:
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
  verified. See the security section below; a mutation test proves it.
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

## 🔴 The security pass — what was wrong, and what now holds it shut

Landed as root `f8a2eac`, ofio `0af5e23`. Prompted by vendoring
`solana-foundation/solana-dev-skill` (see below) and running its
`references/security.md` checklist over `programs/arena/`. Found before any
deploy, so nothing was ever at risk — but every item here would have been live
the moment Phase 3 put the program on devnet with real tokens.

### The critical one: the ed25519 prelude could be forged by any player

`settle_match` read the Ed25519 precompile instruction at index 0 and checked the
pubkey and message bytes **at the offsets that instruction itself encodes** —
while never checking the three `*_instruction_index` fields of
`Ed25519SignatureOffsets`.

Those fields decide *which instruction in the transaction* the precompile reads
the signature, pubkey and message from. Only `u16::MAX` means "this one"; any
other value indexes into the transaction's other instructions (Agave's
`precompiles/src/ed25519.rs`, `get_data_slice`). So:

| ix | contents |
|---|---|
| 0 | Ed25519Program, header setting `sig_ix = pk_ix = msg_ix = 1`. Its *own* bytes at `pk_off` hold the authority's pubkey and at `msg_off` the expected digest — inert filler nothing verifies. |
| 1 | any instruction whose bytes at those same offsets are the **attacker's** key, message and signature. |
| 2 | `settle_match(winner = attacker, …)` |

The precompile verifies the attacker's own signature over the attacker's own
message and returns Ok; `settle_match` reads instruction 0's filler, sees the
authority's key and the right digest, and pays out. The winner only has to be in
`players[]`, which in a 1v1 the attacker is. **Any player in any wagered match
could take the whole pot at will**, and `SettleMatch` declared no `Signer`, so
this was the only authorization there was.

A documented class, not a theoretical one —
[Cantina](https://www.cantina.security/blog/signature-verification-risks-in-solana),
[Asymmetric on Relay](https://blog.asymmetric.re/wrong-offset-bypassing-signature-verification-in-relay/).
The tests never caught it because `buildEd25519InstructionData` writes `0xffff`
for all three indices: they tested the honest client, and nothing tested a
dishonest one.

**The fix** pins all three to `u16::MAX`, plus `num_signatures == 1` and a
16-byte minimum (`message_instruction_index` lives at `d[14..16]`; the old check
was `>= 14`). With the indices pinned, the bytes the precompile verified *are*
the bytes the program reads, so there is nothing left to substitute. Deliberately
layout-agnostic rather than pinning exact offsets, because web3.js's
`Ed25519Program` orders the payload pubkey-then-signature while
`tests/arena.ts`'s helper does signature-then-pubkey.

**The mutation test is the proof.** Remove that one `require!`, rebuild, and
`rejects a prelude whose offsets point at another instruction` fails — because
the forged settlement succeeds. Anyone editing this should run that experiment
once rather than take the comment's word for it.

**A sibling attack that does *not* work**, checked so nobody re-derives it:
`num_signatures = 0` is refused by the precompile itself
(`num_signatures == 0 && data.len() > 2` → `InvalidInstructionDataSize`).

### `cancel_match` let the authority take every stake

`ctx.remaining_accounts[i]` went straight into `token::transfer` as the
destination for `stakes[i]`, with nothing checking it belonged to `players[i]` —
the skill's "unvalidated remaining_accounts" entry verbatim. Only the authority
can call it, but that is the point: the Hard Rule above says the server never
custodies stakes, and until now that was a documented rule with nothing behind
it — the same shape as the Phase 1 start-gate and the stake cap.

Each refund account is now deserialized and checked for `owner == players[i]` and
`mint == match_account.mint`. Done by hand rather than with `Account::try_from`,
which would force the context's `'c` lifetime to `'info`; the explicit
`owner == token::ID` check is load-bearing, because `TokenAccount::try_deserialize`
only unpacks and any 165-byte account would otherwise decode. Mutation-checked
the same way.

### The digest never bound the payout destination

`sha256(match_pda ‖ winner ‖ scores)` says *who won*, not *where the money goes*,
and `winner_token` was unconstrained. Anyone who saw a settle transaction could
rebuild it around the same prelude with their own `winner_token` and win the
race. Two fixes, either of which would do:

- `winner_token.owner == winner`, so a frontrunner's only possible outcome is the
  intended one.
- **`authority: Signer` on `SettleMatch`**, which closes the race outright.
  Free — `settler.ts` already signs as fee payer. Both mechanisms stay and
  `settle_match.rs` says why: the prelude proves what was attested and is
  checkable by anyone holding the authority's pubkey, the signature proves who
  submitted it.

**Residual, deliberately left:** `treasury_token` is still unconstrained and is
not in the digest, so the authority (and only the authority) chooses where the
rake goes. There is no on-chain record of a treasury to pin it against, and
binding it into the digest would break the digest format this file fixes as a
Hard Rule. At `ARENA_RAKE_BPS=0` — the default — there is nothing to take.
**Revisit before rake goes live**, most likely by storing `treasury` on
`MatchAccount` at `create_match`.

### `pot = vault.amount` is correct here — do not "fix" it

The skill warns against deriving value from a raw balance, and the first instinct
was to switch to `sum(stakes)`. That warning targets share maths, where a
donation dilutes other claimants. This is winner-take-all with a single claimant:
a donor can only hand their own tokens to the winner. Reading the balance also
keeps the vault self-emptying, which is what lets `close_match` reclaim the rent
— `sum(stakes)` would strand donations *and* block the close. The rake maths is
now `checked_mul`/`checked_div` (`overflow-checks` was already on, so this
converts a settlement-locking panic into a named error).

### `close_match` — new instruction

Nothing ever removed a terminal match, so every match this key created held its
rent (~0.0084 SOL: a 774-byte `MatchAccount` plus a 165-byte vault ATA) and stayed
in the sweeper's `getProgramAccounts` scan for the life of the key. `close_match`
takes a `Settled` or `Cancelled` match with an empty vault, closes the vault via
CPI and lets Anchor's `close = authority` handle the match account — zeroing,
reassigning and deallocating, which is what stops a revival attack. Anchor closes
after the handler returns, so the PDA is still live to sign for its own vault.

The sweeper calls it in a second pass, capped at `MAX_CLOSES_PER_SWEEP` (20) so
the first sweep after this ships does not fire hundreds of transactions at once.
A close that fails is logged and skipped, not retried: the realistic cause is a
donated-into vault, which `cancel_match` leaves non-empty and always will.

### `declare_id!` was still Anchor's placeholder

`Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` — the well-known example address,
which does **not** match `target/deploy/arena-keypair.json`. bankrun never
noticed; a real deploy would have failed every instruction with
`DeclaredProgramIdMismatch`. Now `4CGRLB5WJ4LK4nqwhzN5uhU78cakuHzG5wfrUZrQ2G64`,
in both `lib.rs` and `Anchor.toml`. Found because Surfpool needed a real deploy.

### `ArenaError` stayed append-only

6000–6010 are unmoved. Added: `WinnerTokenOwnerMismatch` 6011,
`InvalidRefundAccount` 6012, `MathOverflow` 6013, `VaultNotEmpty` 6014,
`MatchNotTerminal` 6015.

## The vendored `solana-dev` skill — and what is deliberately ignored

`.claude/skills/solana-dev/` is a pinned copy of
[solana-foundation/solana-dev-skill](https://github.com/solana-foundation/solana-dev-skill)
v2.4.0 (MIT), commit `718f7cd`. Vendored rather than installed so the version is
fixed, reviewable in the diff and available offline. `VENDOR.md` beside it records
the provenance and how to update.

**Its stack advice is not followed here, on purpose.** It is Kit-first and
Anchor-1.1-first; read it for security, concepts and Surfpool, not as a mandate
to migrate.

| Skill recommends | This project | Why |
|---|---|---|
| Anchor 1.1.x | **0.31.1** | See the toolchain section above for how much was burned getting 0.31.1 + Agave 4.2.1 to build at all. Its own matrix calls 0.31.x transitional but functional. Revisit after Phase 3. |
| `@solana/kit` v7; drop web3.js v1 | **web3.js v1** | `arenaProgram.ts` is hand-rolled precisely to avoid a large client dep, and it ships to the browser. Kit's tree-shaking is a real future win for the 294 kB `wagerJoinFlow` chunk — a spike, not a mandate. |
| Surfpool instead of bankrun | **bankrun**, plus Surfpool | 42 bankrun tests pin the bindings and the decoder. Surfpool is used for what bankrun cannot do; see `docs/surfpool.md`. |
| `@solana/react` + Wallet Standard | `client/arena/WalletProvider.ts` | Works. The migration target if wallet support widens. |

Its `W011` rule — validate owner, length and discriminator before deserializing
anything from chain — is already what `decodeMatchAccount` does. Independent
confirmation, not a change.

`.mcp.json` adds the Solana MCP server (`https://mcp.solana.com/mcp`, HTTP, no
auth) at project scope, for Anchor constraint and error questions. Treat its
answers as documentation, not as authority over this file.

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
- **Anchor program** (`programs/arena/`): five instructions implemented —
  `create_match` (vault is a real PDA-owned ATA), `join_match`, `settle_match`
  (on-chain ed25519 verified *and* authority-signed), `cancel_match` (ported,
  hardened, refund accounts now pinned to `players[]`), `close_match` (rent
  reclamation). **Compiles** under the toolchain above; `arena.so` + IDL + types
  are generated, at the real program id rather than Anchor's placeholder.
- **Tests**: 42 passing on the program side (`tests/arena.ts` for behaviour,
  `tests/arenaProgram.ts` for the shared bindings, decoder and settlement), 3 more
  under `npm run test:surfpool` against a really-deployed program, and
  3492 passing on the game side (`npm test` from `OpenFrontIO/`, which runs the
  suite and then re-runs `tests/server`, so those files are counted twice —
  2996 + 496). Includes `tests/ArenaWalletAuth.test.ts` and, under
  `tests/server/`, `ArenaStartGate`, `AppShellBranding`, `ArenaDevBypass`,
  `ArenaPreflight`, `ArenaSweeper` and `AuthService`.
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
- **Auth service** (`OpenFrontIO/src/auth/`): this fork's replacement for
  upstream's closed-source JWT issuer — JWKS, `/auth/refresh`, `/users/@me`,
  wallet login. Stateless, its own process and container at `api.$DOMAIN`.
  Without it the site can only run as `GAME_ENV=dev`. See
  `OpenFrontIO/docs/Auth.md`.
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

**This is the single refund site for a lobby this process still holds.**
`cancelUnfilledWageredMatch()` deliberately does not refund inline — it sets
`_hasEnded`, `phase()` reports `Finished`, `GameManager` calls `end()`, and the refund
happens there. Anything else that cancels a wagered lobby pre-start should route the
same way rather than adding a second call.

The H2 sweeper is not an exception to that rule; it is what happens when the rule has
nobody left to apply it. It refunds only escrows **no `GameServer` exists for any more**
— the process that owned them died — so there is no `end()` to route through. The two
cannot collide either, and not by luck: the sweeper's `Open` window starts an hour
*past* `maxGameDuration`, which is exactly the point by which `end()` has already run
for every lobby a live process was managing.

Note also that `cancelUnfilledWageredMatch()` kicks with `kick_reason.wager_not_full`,
**not** `kick_reason.match_cancelled`: the latter's client handler pushes the player back
into the matchmaking queue, which is wrong for a private lobby the host built by hand.

## Roadmap — where this actually is
Full plan: `~/.claude/plans/where-are-we-on-staged-snowflake.md`. Phases, in
dependency order:

| Phase | What | State |
|---|---|---|
| **1** | Wagered start-gate + refund the unstartable | ✅ root `a283bfc`, ofio `c76ed24` |
| **2** | `ARENA_DEV_BYPASS` containment + stake cap | ✅ ofio `cecbe4b` |
| **H5** | Stop shipping upstream's identity (licensing) | ✅ ofio `8a9ab4d` |
| **H3** | Program: timeout-cancel for a stranded `InProgress` match | ✅ root `552425c` |
| **H1** | Arena env vars + keypair mount + boot preflight | ✅ ofio `f1b3832` |
| **H2** | Recovery sweeper (master-only, enumerates by authority) | ✅ ofio `fca7567` |
| **H4** | Auth service — JWKS, `/auth/refresh`, `/auth/wallet`, `/users/@me` | ✅ ofio `95e4b56` |
| **H6** | The Oracle Cloud box | todo, needs a domain + region |
| **3** | Devnet deploy + live validation (S1–S7) | needs H6; program-side blockers cleared |
| **4** | Server-side replay winner determination | **mainnet gate** |

**Phase H is done.** Everything left needs the domain: H6 is the box, and
Phase 3's live validation runs on it.

### H4 — the auth service (done)

Upstream's JWT issuer is a **closed-source Cloudflare Worker that is not in the
repo**, so this fork could only ever run as `GAME_ENV=dev`: `verifyClientToken`
refuses a bare persistentID outside dev, `ServerEnv.jwkPublicKey()` throws with
no JWKS to fetch, and `Worker.ts` closes the socket when `/users/@me` fails.
`OpenFrontIO/src/auth/` replaces the auth half of it. Full detail in
`OpenFrontIO/docs/Auth.md`; the notes worth keeping:

- **It has no database, and that is the design.** Upstream's API is backed by
  accounts, subscriptions, cosmetics and clans; this fork has none, so every
  field `/users/@me` returns is derived from the session or is an operator
  constant. A guest's identity lives in its refresh cookie; a wallet's is
  *derived* from the address, so the same wallet is the same player everywhere
  with nothing stored and no reverse lookup to leak. Same posture as the H2
  sweeper, which survives a crash precisely by keeping no server-side state.
- **The stated cost:** with no store there is no revocation list.
  `/auth/revoke` can only clear the cookie, so an issued access token stays
  valid for up to its 15-minute life. Closing that needs storage.
- **The three token kinds are separated by `aud`, not by a hand-written check** —
  access → `$DOMAIN`, refresh → `<issuer>/auth/refresh`, challenge →
  `<issuer>/auth/wallet`. `jwtVerify` enforces the audience itself, so a refresh
  cookie replayed as a bearer token fails *verification* rather than depending
  on a guard someone might later drop. Tests assert each direction.
- **A cookieless `/auth/refresh` mints a new guest rather than failing.** It is
  the browser's only guest path (`Auth.ts`'s `doRefreshJwt` falls through to
  it), so a 401 would leave a first-time visitor with no session at all — and
  would make `Auth.ts` log out and clear their flag and pattern settings. It is
  also why that route is rate limited: each cookieless call creates an identity.
- **`iss` is pinned, not configured.** `ServerEnv.jwtIssuer()` and
  `ClientEnv.jwtIssuer()` each *compute* `https://api.$DOMAIN` (or
  `http://localhost:8787`) and reject anything else, so `AUTH_PORT` deliberately
  does not feed the issuer — `warnIfPortMismatch()` says so at boot.
- **The signing key is never auto-generated for a configured path.** A container
  minting one per start would invalidate every session on each deploy, and the
  game server caches the first JWKS response for the life of its process, so it
  would keep rejecting tokens until it too restarted. Outside dev the service
  **refuses to boot** without `AUTH_SIGNING_KEY_PATH`; in dev it generates an
  ephemeral key and says so loudly. `scripts/generateAuthKey.ts` writes it once,
  mode 600, and refuses to overwrite.
- **`src/auth/` must not import `src/server/`.** `ServerEnv` throws for vars the
  auth service has no business setting (`NUM_WORKERS`, `GIT_COMMIT`,
  `TURNSTILE_SITE_KEY`) and `server/Logger.ts` wires OpenTelemetry at import
  time — either would make the service unable to boot alone. It shares only
  `src/core/`, which is the point: `TokenPayloadSchema` and
  `UserMeResponseSchema` are literally the same module on both ends. That is
  also why `verifyEd25519Signature()` was extracted to
  `core/arena/walletSignature.ts` rather than copied.
- **Wallet login uses a different signed message from the per-match one.**
  `walletLoginMessage()` sits beside `authMessage()` in
  `core/arena/authMessage.ts` with a distinct prefix, so a captured match
  signature can never be replayed as a login. A test signs `authMessage(nonce)`
  against `/auth/wallet` and asserts a 401 — that is what fails if the prefixes
  are ever unified.
- **Wallet login is server-side only for now.** The arena verifies wallet
  ownership per match on its own, so nobody needs it to stake, and a browser
  sign-in would change a player's persistentID mid-session.
- **`npm run dev` is unchanged**; `npm run dev:auth` runs client + game server +
  auth, which is how a real `jti` (and therefore the real wallet-signing nonce)
  gets exercised locally instead of `devAuthNonce()`.
- **`tests/server/AuthService.test.ts` runs under `// @vitest-environment node`.**
  The repo default is jsdom, whose `TextEncoder` is a different realm — jose and
  tweetnacl both type-check with `instanceof`, so every sign() fails there with
  "payload must be an instance of Uint8Array". The service only ever runs in
  Node anyway.
- `ServerEnv`'s `JwksSchema` is now **exported**, so the suite pins the auth
  service's JWKS against the schema the game server actually enforces rather
  than a copy of it. A JWKS the game refuses breaks every join.

### H1's `update.sh` half had never landed — corrected here

`update.sh` expanded `"${ARENA_MOUNT[@]}"` but **nothing ever defined the
array**: `git log -S ARENA_MOUNT -- update.sh` shows `f1b3832` added only the
one-line reference. The keypair mount, the `SERVER_KEYPAIR_PATH` append, the
refusal on a missing source file and the `RESTART=always` forcing were all
absent, and with `set -eo pipefail` (no `-u`) the expansion silently produced
nothing — so a deploy quietly built a **free-to-play server**, the exact failure
H1's commit message claims to have fixed. All four are now in the file, next to
the same mechanism the auth signing key needed.

### H1 — the arena now reaches a real deployment (done)
Three things were missing between the code and a deployed container:
- **`deploy.sh`'s env heredoc is a fixed list** and had no `ARENA_*` in it, so a
  deploy silently produced a free-to-play server.
- **`SERVER_KEYPAIR_PATH` is a file path and nothing mounted a file.** It now
  arrives as a **read-only bind mount** (`ARENA_AUTHORITY_KEYPAIR` on the host →
  `/run/secrets/arena-authority.json`), never an env var — an env var would sit in
  `docker inspect`, in the deploy env file, in `ps`, and in any crash dump that
  prints the environment. `update.sh` appends `SERVER_KEYPAIR_PATH` itself, since
  it must name the in-container path. It also **refuses to start when the source
  file is missing**: Docker silently creates a *directory* for an absent bind
  source, which would surface later as an unreadable keypair.
- **`RESTART=no`** unless the subdomain was `main`. Setting `ARENA_AUTHORITY_KEYPAIR`
  now forces `--restart=always` — a wagering server that stays down after a crash
  leaves live escrows with nothing to settle or refund them, and the sweeper only
  runs while the process does.

### H2 — the recovery sweeper (done)

`matchRegistry` is a module-level `Map` inside each **worker**. A worker crash
(the master reforks it), a redeploy, or an OOM drops every live wager, and with
it the only pointer the server held to tokens still sitting in a vault. Hosting
makes that routine rather than exceptional.

`arena/sweeper.ts` recovers them from chain state alone. `MatchAccount` already
records `authority`, `vault`, `players[]`, `stakes[]`, `status` and `created_at`,
so `getProgramAccounts` filtered on the authority enumerates every escrow this
server ever created with **no server-side persistence at all**. That is exactly
why it survives the thing that destroyed the registry: it never reads it.

- **Master-only, and that is load-bearing.** N workers sweeping means N
  concurrent `cancel_match` transactions per orphan — one succeeds, the rest
  pay a fee to be rejected. The master supervises the workers, holds the same
  env and therefore the same keypair, and does no other arena work. It runs its
  own `runWagerPreflight()` first, because it is about to sign transactions;
  `startSweeper()` is a no-op unless that passed. In-process, an `inFlight`
  guard keeps a slow sweep from overlapping the next tick.
- **`InProgress` reuses `MATCH_TIMEOUT_SECS`** — the deadline `cancel_match`
  enforces itself. A shorter sweeper-side number would only submit doomed
  transactions.
- **The `Open` window is the dangerous one.** The program accepts a cancel on an
  `Open` match at *any* age, so nothing on chain stops the sweeper refunding a
  lobby that is still filling — the constant is the only thing that does.
  **The plan's 2 h was wrong.** A private lobby with no armed start timer sits in
  the `Lobby` phase for the full `maxGameDuration` of 3 h (`lessThanLifetime` in
  `phase()` is unconditionally true without a `startsAt`), so 2 h would have
  refunded players mid-lobby. It is now `MAX_GAME_DURATION_MS + 1 h`: past that,
  `phase()` reports `Finished` and `end()`'s not-started branch refunds the lobby
  itself, so an escrow still `Open` beyond it is one no live `GameServer` can be
  managing — in this process or any other sharing the authority key. The extra
  hour stops the sweeper racing that ordinary refund.
- **`MAX_GAME_DURATION_MS` was hoisted** out of `GameServer`'s private field into
  `core/Schemas.ts` so the window is *derived* rather than hand-copied. Two
  copies of "3 hours" is exactly the drift that would reintroduce the bug.
- **It queries one status at a time**, because `getProgramAccounts` AND-s its
  filters and offers no OR. Four queries now, in two passes: `Open` and
  `InProgress` are the orphan scan, `Settled` and `Cancelled` are the
  rent-reclaim pass added with `close_match`. Before that instruction existed the
  terminal set was filtered out and left to grow for the life of the authority
  key; now it is actually cleared, capped at `MAX_CLOSES_PER_SWEEP` per tick so
  the first sweep after it shipped does not fire hundreds of transactions.
  A close that fails is logged and skipped rather than retried — the realistic
  cause is a donated-into vault, which is never empty.
- **Errors are isolated per match**, not per sweep: one unrecoverable pot must
  not strand every other one behind it.
- `settler.ts`'s refund path was split into **`cancelAndRefund()`**, which takes
  chain state and nothing else, so both callers share one implementation of the
  `players[]`-order pairing `cancel_match` requires. It reads `vault` from the
  account rather than the registry — which is what the program pins with
  `address = match_account.vault` regardless.

### `arena/preflight.ts` — verify at boot, not when a host presses the button
`wageringConfigured()` only asked whether two env vars were non-empty, and is gone.
`runWagerPreflight()` additionally loads the keypair, confirms the program account
exists **and is executable on this cluster**, and checks the authority's balance
against `MIN_AUTHORITY_LAMPORTS`. `wagerAvailable` on `GET /api/game/:id` reports
the verified answer, so the host UI no longer advertises an escrow the server
cannot create.

**The check that matters most is the rake one.** `ARENA_RAKE_BPS > 0` with no
`TREASURY_TOKEN_ACCOUNT` used to fail at *settlement* — by which point the stakes
are in the vault and `settler.ts` correctly refuses to guess where the rake goes,
so the pot just sits there. At boot it is a one-line refusal instead.

Disabling wagering is safe by construction: it is the same state as a server that
was never configured for it. A misconfiguration is distinguished from a deliberate
free-to-play server — `ARENA_PROGRAM_ID` unset is `off` and logs at info, anything
malformed is `broken` and logs at error, and `/wager` returns the reason so it is
diagnosable without a log dive.

### Phase 2 — the dev bypass is opt-in *and* cluster-gated (done)
Two bypasses used to fire on `GameEnv.Dev` alone — the `jti`-nonce fallback in
`walletAuthNonce` and the on-chain stake check in `Worker.ts`. Together they let a
player hold a wagered seat without paying, which fills the escrow to `InProgress`
with a partial pot that then settles and pays out. With `ARENA_PROGRAM_ID` pointed
anywhere real, that was dev mode moving real tokens.

`arena/devBypass.ts` is now the single predicate. Notes:
- **`ARENA_DEV_BYPASS=true` is necessary but not sufficient.** `resolveDevBypass()`
  also asks the cluster for its **genesis hash** and refuses mainnet-beta. The URL
  proves nothing — a provider endpoint need not contain "devnet", a proxy can hide
  it, and a typo'd variable pointing at mainnet reads as ordinary text.
- **Everything fails closed.** `devBypassEnabled()` reads false until resolution
  succeeds, so not-requested, mainnet, unreachable RPC and never-resolved all land
  on the strict path. This costs nothing in production: the check only runs when
  the bypass was requested, so a flaky RPC can never affect a server that never
  asked. That is why this is *not* a refuse-to-boot check — that would trade a real
  availability risk for no extra safety.
- **Unknown genesis is allowed on purpose.** `solana-test-validator` mints a fresh
  one every start; refusing it would make the bypass useless for its main case.
- **The client is told the resolved answer** via `BOOTSTRAP_CONFIG` →
  `ClientEnv.arenaDevBypass()`, not left to infer it from its own `GameEnv`. A dev
  client that assumed dev-implies-bypass would prompt the wallet and then have the
  server reject the signature — Stage 6's rule is to refuse *before* prompting.
- **`resolveDevBypass()` runs in both the master and every worker.** Module state is
  per-process, and the master needs it too because it renders the app shell.

### `ARENA_MAX_ENTRY_FEE` — the stake cap that did not exist
The accepted-risk section below says not to raise stake limits while the winner is
client-voted. There was no limit to raise: `POST /:id/wager` accepted any non-zero
u64, and the program bounds `rake_bps` and `max_players` but leaves `entry_fee`
unbounded. Same shape as the Phase 1 start-gate — a documented rule with nothing
behind it.

Server-side rather than on-chain because it is **policy, not fund safety**: the
escrow is equally sound at any stake, and a compiled-in constant cannot be
denominated without the mint's decimals. A malformed value **throws** rather than
defaulting to "no cap" — a typo'd ceiling that silently means unlimited is exactly
the failure being prevented.

### Fixed stake tiers — 1 / 5 / 25, and one operator-set token

Hosts no longer type an amount or a mint. They pick a **tier** — 1, 5 or 25
whole units of `ARENA_STAKE_MINT` — and the server derives everything else.
Product direction from DamnBruh (fixed $1/$5/$20 lobbies), but the mechanism is
chosen for a security property:

> The server derives `entry_fee` from the tier. The client never sends an
> amount. So an off-tier stake is not *rejected*, it is **unrepresentable**.

Same reasoning as gating a wagered start on the escrow reporting `InProgress`
rather than on a seat count: a check that cannot drift from the rule it
enforces. `POST /api/game/:id/wager` now takes `{ tier, maxPlayers }`; `mint`
and `entryFee` are gone from the wire entirely, and a client sending the old
shape gets a 400 for a missing `tier`.

- **`STAKE_TIERS` lives in `core/arena/stakeTiers.ts`, which imports nothing.**
  Not even Zod — the root bankrun suite reaches across into `OpenFrontIO/` and
  can only do that for modules free of OpenFrontIO imports and Node built-ins,
  and Zod is not a root dependency. `Worker.ts` builds its validation *from* the
  array rather than hand-writing a literal union, which would be exactly the
  drift this is meant to prevent.
- **A drifted client copy cannot create a wrong escrow.** It can only offer a
  tier the server refuses. The shared list is for rendering; the derivation has
  one implementation.
- **`ARENA_MAX_ENTRY_FEE` filters the tiers** rather than getting a parallel
  `ARENA_MAX_STAKE_TIER` beside it — one cap knob. Its meaning now depends on
  the mint's decimals (the same number is tier 5 at 6 decimals and 0.005 at 9),
  so `stakeMint.ts` logs which tiers it took the cap to mean. A cap that
  suppresses *every* tier is refused at boot.
- **Tier 25 at 16 players is a 400-token pot**, and `maxPlayers` is still
  host-chosen. The accepted-risk section says not to raise stake limits while the
  winner is client-voted, and a small or 1v1 wagered lobby is the easiest place
  to collude — `example.env` suggests suppressing 25 until Phase 4.

### `arena/stakeMint.ts` — the staking token, resolved at boot

Shaped after `devBypass.ts`, **not** folded into `preflight.ts`'s `Preflight`
union. `Preflight` is a verdict type and `runWagerPreflight()`'s return value is
discarded at both call sites, so widening its `ok` variant would quietly make it
load-bearing where nobody reads it. A lazily self-resolving accessor would put
an `await` back on the request path that H1 removed, and a module-scope memo
would re-create the master/worker dotenv trap — so env is read *inside*
`resolveStakeMint()`. `stakeMint()` reads null until resolution succeeds, the
same fail-closed posture as `wageringOperational()`.

What it refuses at boot, and why each one matters:

- **Not owned by the legacy SPL Token program.** The arena pins
  `Program<'info, Token>`, so a **Token-2022 mint can never be escrowed** —
  previously that surfaced as a failed `create_match` on a lobby the host had
  already set up. Mutation-checked. It also means transfer-fee and transfer-hook
  extensions cannot apply here, which is worth writing down so nobody
  re-derives it as a risk.
- **Uninitialized.** An uninitialized 82-byte account decodes as `decimals = 0`,
  which would silently turn every tier into 1/5/25 *base units* — a stake of
  0.000001 tokens that looks entirely normal.
- **More than 9 decimals.** Not arbitrary: `25 * 10^18` overflows a u64, and
  `u64LE()` throws inside `buildCreateMatchIx`, so a high-decimals mint would be
  a **502 on a live lobby**. The arithmetic ceiling is 17; 9 is deliberately
  stricter (SOL is 9, USDC is 6). Raising it past 17 is a correctness bug, not a
  policy change.
- **A freeze authority is warned about, not refused.** Picking one mint for the
  whole deployment turns a per-lobby risk into a global one: a frozen vault or
  player token account fails **both** `settle_match` and `cancel_match`, and H3's
  timeout does not help because it is the transfer itself that fails. Whether
  that is acceptable is the operator's call.

**`TREASURY_TOKEN_ACCOUNT` is finally checked.** `example.env` always said it
must hold the same mint the match is staked in; nothing enforced it — the same
documented-rule-with-nothing-behind-it shape as the Phase 1 start gate and the
stake cap. A mismatch fails `settle_match`'s rake CPI, which fails the whole
settlement and strands the pot until the 24h timeout. Only checkable now that the
server knows the mint at boot. Mutation-checked.

**Amounts are formatted everywhere now.** `formatStake()` does BigInt string
surgery and **never touches `Number`** — `entryFee` crosses the wire as a string
precisely because a u64 loses precision above 2^53, and parsing it back to a
float to divide would reintroduce exactly that. A prompt reading `5000000` where
the host chose "5" is how someone stakes the wrong amount believing they checked.

`WagerConfig` records `decimals` and `symbol` **per match**, for the same reason
it records `programId`: it makes `toWagerInfo()` a pure function of the config
rather than a reader of current global state. Do not "simplify" `WagerConfig.mint`
to a `stakeMint()` call — `verifyOnchainMembership` compares the on-chain match's
mint against that value, so an operator who repointed the token would kick every
player of every live match.

**`wagerOptions` is separate from `wager` on `GET /api/game/:id`** because the
host picks a tier *before* any escrow exists, and `wager` is per-match and absent
until one does.

### Where the lobby UI is going — DamnBruh, and what of it does not apply

The direction is [DamnBruh](https://www.damn-bruh.com/): fixed tiers, real-time
matchmaking that pairs players **by stake level**, a pot-first presentation.
Three parts of that model do **not** transfer, and must not be adopted by
default:

| DamnBruh | Here | Why |
|---|---|---|
| Public tier matchmaking | **Private lobbies only** | The winner is decided by client-majority vote. A public tier queue is the easiest possible collusion surface. **Phase 4 is the gate.** |
| Custodial Privy wallets | Non-custodial Phantom | Hard Rule: the server never holds user funds. |
| 10% fee on withdrawal | `rake_bps` at settlement | And the `treasury_token` residual is still open — see the security section. |

**Done:** `WagerLobby.ts` is now light-DOM Tailwind on the design tokens, using
`o-button` like everything else. It was the last shadow-DOM island in the
codebase, with a hand-written `#1a1a2e`/`#e94560` palette that matched nothing —
and the shadow boundary was *why* it missed every token. It is also pot-first
now: the headline is what the winner actually takes (net of rake), because that
is the number that decides whether someone plays, not the row of labels it used
to lead with. The mint stays on screen beside the symbol, deliberately —
`ARENA_STAKE_SYMBOL` is an operator string, not on-chain metadata, so the ticker
alone is an unverifiable claim. `tests/client/WagerLobby.test.ts` is the first
thing ever to render this component; it pins the formatting and the light DOM,
and is mutation-checked both ways.

Designed but deliberately **not built**: a tier lobby browser (three cards
showing live lobbies at each stake with pot, joined/max and countdown) and a
quick-join queue per tier — both gated on Phase 4. Note also that a joining
player currently sees no lobby preview at all before staking, because the gate
runs before `joinLobby()`; a tier browser should fix that.

**When that ships, the flag must not be a bare boolean.** `PublicGameInfoSchema`
would need a wager field, and `ARENA_PUBLIC_WAGER_LOBBIES` must be honoured only
when server-side winner verification is actually available — checked at boot,
failing closed, exactly the shape of `resolveDevBypass()` refusing to trust
`ARENA_DEV_BYPASS=true` until it has asked the cluster for its genesis hash. A
dormant public-lobby path guarded only by operator discipline is a collusion
surface one edit away from being live.

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
- **`npm run dev:auth` gets you a real `jti` locally.** Since H4 the fork has its
  own JWT issuer, so a dev session can hold a genuine JWT instead of a bare
  persistentID — the wallet signature then binds to a session rather than falling
  back to `devAuthNonce()`. `npm run dev` is unchanged and still uses the
  anonymous path.

#### Standing the whole thing up — done once, works

`docs/surfpool.md` covers the validator; this is the rest of it, and it has been
run end to end: the host UI offered the stake control, `POST /wager` created a
real escrow, and `solana account` showed a `MatchAccount` owned by the program
with a vault ATA owned by the match PDA. That path had never executed outside
bankrun before.

```bash
# WSL: validator, then deploy at the DECLARED id
surfpool start --offline --no-deploy --no-tui --port 8899
solana config set --url http://127.0.0.1:8899
solana airdrop 100
solana program deploy --program-id target/deploy/arena-keypair.json     target/deploy/arena.so

# WSL: the match authority (NOT the deployer) and a token to stake
solana-keygen new --no-bip39-passphrase -o OpenFrontIO/.keys/arena-authority.json
solana airdrop 50 "$(solana address -k OpenFrontIO/.keys/arena-authority.json)"
spl-token create-token --decimals 6
```

Then `OpenFrontIO/.env` — `SOLANA_RPC_URL` and `ARENA_PUBLIC_RPC_URL` at
`http://127.0.0.1:8899`, `ARENA_PROGRAM_ID` at the deployed id,
`SERVER_KEYPAIR_PATH=.keys/arena-authority.json`, `ARENA_RAKE_BPS=0` — and
`npm run dev`. Boot should say `wagering enabled and verified` **three times**
(master plus both workers) and then `[arena/sweeper] recovering orphaned
escrows`. Fewer than three, or no sweeper line, means the master disagrees with
its workers — see the ordering trap below.

`.keys/` and `.env*` are both gitignored. Nothing here is worth protecting, but
keep it that way.

**What still cannot be exercised headlessly:** actually staking. `join_match` is
submitted by the *browser*, so it needs a wallet extension pointed at
`http://127.0.0.1:8899`. Everything up to the stake prompt works without one.

#### The master/worker env trap — cost an hour, will recur

`Server.ts` calls `dotenv.config()` **after** its imports, and ESM evaluates the
entire module graph before any statement in the entry file runs. So any
module-level `process.env` read in that graph sees an **empty** environment in
the master — while forked workers, handed an already-populated `process.env` by
`cluster.fork()`, read the right value.

`arena/rpcClient.ts` had exactly one: `new Connection(process.env.SOLANA_RPC_URL
?? "https://api.devnet.solana.com")` at module scope. The master therefore
pointed at **devnet** while its workers pointed at the configured RPC. The
symptom was a boot log that read as a flake — the master reporting the program
"not deployed on this cluster", both workers verifying the same program 1.5 s
later. Preflight fails closed, so the master silently never started the H2
sweeper: the one recovery mechanism meant to survive a crash, disabled by an
import order.

It only bites env-file setups; a container passing real env vars has them before
node starts. Fixed by making the connection **lazy and memoized**
(`getConnection()`), deliberately *not* by moving `dotenv` above the other
imports — prettier reorders imports in this repo, so an ordering-dependent fix
would be one `npm run format` away from coming back.
`tests/server/ArenaRpcClient.test.ts` pins the timing, and is mutation-checked:
restore the eager read and two of its four tests fail.

**Any new module-level `process.env` read under `src/server/` inherits this
bug.** Read env inside a function, as `ServerEnv` already does.

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

**And it has two renderers, which is how this bit us.** `RenderHtml.ts` renders
it in production; **`vite.config.ts` renders it for `npm run dev`**, from its own
hand-maintained copy of the same data. H5 added `siteOrigin`/`siteName`/
`sourceRepoUrl` to the template and to `RenderHtml.ts` and not to the vite
config, and Phase 2's `arenaDevBypass` went the same way — so `npm run dev`
served a **500 (`siteOrigin is not defined`) for every page load** until it was
found by trying to look at the UI. `git log -- vite.config.ts` showing no arena
commits at all was the tell. `AppShellBranding.test.ts` now also asserts that
every EJS variable in the template has a key in `vite.config.ts`; that half is a
static text check, because the vite data lives inside `defineConfig`'s closure
and inside `createHtmlPlugin`'s options, so there is nothing to import and
render. **A new template variable needs adding in both places.**

`arenaDevBypass` is deliberately the *requested* value in the vite config rather
than the resolved one — `resolveDevBypass()` also asks the cluster for its
genesis hash, which a config file cannot do. It is a hint that keeps the local
wager loop testable, and the server remains the only thing that decides. It
cannot leak past dev: `createHtmlPlugin` is only registered when
`!isProduction`, and production renders through `RenderHtml.ts`.

## Conventions
- Commits: conventional commits (`feat(arena):`, `fix(program):`, …).
- Inside `OpenFrontIO/`, mark every edit to a pre-existing upstream file with an
  `// [ARENA]` comment — see `OpenFrontIO/docs/upstream-map.md`. This keeps upstream
  merges tractable.
- Checks before declaring done:
  - Program: from WSL, `anchor build && anchor test --skip-deploy --skip-local-validator`
  - Program, optionally: `npm run test:surfpool` against a local Surfpool with the
    program deployed — the only way to reach `MATCH_TIMEOUT_SECS`. `docs/surfpool.md`.
  - **Root `npm` scripts must be run from WSL.** `node_modules` is installed there
    (`solana-bankrun` is a native NAPI module), so the `.bin` shims are Linux ones
    and Windows fails with `'ts-mocha' is not recognized`.
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
- **Security-relevant program changes need a mutation test**, not just a passing
  one. Break the check on purpose, rebuild, and confirm the test fails; a test
  that still passes without the fix is not testing the fix. The two that matter
  most are named in the security section above.
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
- `ARENA_AUTHORITY_KEYPAIR` — **deploy only**, path to the keypair *on the target
  host*. `update.sh` bind-mounts it read-only and sets `SERVER_KEYPAIR_PATH` to the
  in-container path itself. Setting it also forces `--restart=always`.
- `ARENA_DEV_BYPASS` — **dev only, default off.** Skips the wallet-signature session
  binding and the on-chain stake check. Only honoured when `GAME_ENV=dev` **and** the
  cluster's genesis hash proves it is not mainnet; refused if the RPC is unreachable.
- `ARENA_STAKE_MINT` — the SPL token every stake is denominated in. **Required
  once `ARENA_PROGRAM_ID` is set.** Verified at boot: must exist, be owned by the
  **legacy** Token program (Token-2022 can never be escrowed), be initialized,
  and declare at most 9 decimals.
- `ARENA_STAKE_SYMBOL` — display-only ticker, max 12 of `[A-Za-z0-9._-]`. An
  operator claim rather than on-chain metadata, which is why the mint address
  stays visible beside it in the stake prompt.
- `ARENA_MAX_ENTRY_FEE` — ceiling on one seat's stake, in token base units. Empty
  means no ceiling. Operator-set, never host-set. Now also **filters which of the
  1/5/25 tiers are offered**, and its meaning depends on the mint's decimals —
  the boot log says which tiers it was taken to mean.
- `AUTH_SIGNING_KEY_PATH` — the auth service's Ed25519 private JWK. **Refuses to
  boot outside dev when unset**; dev generates an ephemeral key. Never
  auto-created for a configured path — see H4 above.
- `AUTH_SIGNING_KEY` — **deploy only**, path to that key *on the target host*.
  `update.sh` bind-mounts it read-only and sets `AUTH_SIGNING_KEY_PATH` itself.
  Setting it is also what makes the deploy start an auth container at all.
- `AUTH_PORT` — auth service listen port, default 8787. Does **not** change the
  issuer, which both the game server and the browser compute themselves.
- `AUTH_COOKIE_DOMAIN` / `AUTH_COOKIE_SECURE` — refresh-cookie attributes. Empty
  domain means host-only (`api.$DOMAIN`), which is the only reader; `Secure`
  defaults on outside dev.
- `AUTH_ALLOW_PUBLIC_LOBBIES` — whether `/users/@me` reports
  `canCreatePublicLobbies`. Upstream gates it on a subscription; this fork has
  no subscription backend, so it is the operator's call. Wagered lobbies stay
  private-only regardless.
- `AUTH_ALLOWED_ORIGINS` — extra origins allowed to send credentialed auth
  requests. `https://$DOMAIN`, its subdomains and dev localhost are allowed
  without listing.
- `SITE_NAME` — public display name, used for `og:title`. Falls back to `DOMAIN`.
- `SOURCE_REPO_URL` — where **this** deployment's source lives. Drives the footer
  link. **Unset is an AGPL problem, not a cosmetic one** — see below. The master
  logs a warning at boot outside dev.
- Existing OpenFront vars (`GAME_ENV`, `API_KEY`, `DOMAIN`, …) — see its `example.env`

**Ops requirement:** the server keypair needs a funded SOL balance to pay rent for each
match's `MatchAccount` and vault ATA. Use a devnet faucet for testing.
