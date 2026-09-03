# Surfpool — testing what bankrun cannot

The 42 tests in `tests/arena.ts` and `tests/arenaProgram.ts` run under
[bankrun](https://kevinheavey.github.io/solana-bankrun/): an in-process SVM that
loads `target/deploy/arena.so` directly. That is why they are fast and hermetic,
and it is also their limit — **bankrun is not a deploy**. It never exercises
`solana program deploy`, `declare_id` matching, real fee payment, real
`getProgramAccounts`, or a validator's clock.

`tests/surfpool/` covers the gap for the one case that matters most:
`MATCH_TIMEOUT_SECS` is 24 hours, and Surfpool's `surfnet_timeTravel` cheatcode
is the only practical way to reach it against a real validator. On a plain
`solana-test-validator` you would have to wait a day.

This is **Phase 3 preparation**. Nothing in the normal workflow depends on it.

## Install (once, in WSL)

Surfpool is a native binary and belongs alongside the rest of the Solana
toolchain, which on this machine lives in WSL.

```bash
curl -sL https://run.surfpool.run/ | bash     # installs to ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"
surfpool --version                            # 1.5.0 at time of writing
```

**Do not `cargo install surfpool`.** That crates.io name is squatted by an
unrelated crate — see the vendored skill's `references/testing.md`.

## Run

Three terminals' worth of commands, all from WSL, all from the repo root:

```bash
# 1. a local validator. --offline because we deploy our own program and fork
#    nothing; --no-deploy because we deploy by hand rather than through a txtx
#    runbook; --no-tui prints plain, greppable logs instead of the dashboard.
surfpool start --offline --no-deploy --no-tui --port 8899

# 2. build, then deploy at the DECLARED id -- `--program-id` names the keypair,
#    and its pubkey must equal declare_id!() or every instruction fails with
#    DeclaredProgramIdMismatch.
anchor build
solana airdrop 100 --url http://127.0.0.1:8899 --keypair ~/.config/solana/id.json
solana program deploy --url http://127.0.0.1:8899 \
    --keypair ~/.config/solana/id.json \
    --program-id target/deploy/arena-keypair.json \
    target/deploy/arena.so

# 3. the suite
npm run test:surfpool
```

`SURFPOOL_RPC_URL` and `ARENA_PROGRAM_ID` override the defaults
(`http://127.0.0.1:8899` and the declared id).

To start over: `surfnet_resetNetwork` wipes everything **including balances**,
so airdrop and redeploy after it.

## Gotchas that cost time

- **`surfnet_timeTravel`'s `absoluteTimestamp` is in milliseconds.** The
  cheatcode reference calls it a UNIX timestamp, and the clock it moves —
  `Clock::unix_timestamp`, and therefore `MatchAccount.created_at` — is in
  seconds. Passing seconds is rejected with `Cannot travel to past timestamp:
  target=…, current=1788368504756`; note the 13-digit `current`. The test
  converts in one place, `timeTravelToSeconds`.
- **The clock only moves forward.** Each run creates a match with a nonce
  derived from `Date.now()`, so re-running against a surfnet already travelled
  into the future is fine — but a fixed nonce would collide on `init`.
- **`NO_DNA=1` does not suppress the TUI**, despite what this file said until
  someone tried it: the dashboard still launches and fills the log with ANSI
  cursor moves. The flag is `--no-tui`.
- **`npm run test:surfpool` must be run from WSL.** The root `node_modules` is
  installed there (`solana-bankrun` is a native NAPI module), so the `.bin`
  shims are Linux ones and the script fails from Windows with
  `'ts-mocha' is not recognized`.
- **The default mocha glob is `tests/*.ts`, not `tests/**/*.ts`.** That is what
  keeps this directory out of `anchor test`, which has no validator listening.
  Widening the glob back will break `anchor test` with connection errors.

## What else Surfpool would be good for

Not built yet, listed because the reasoning is the useful part:

- **Forked-cluster validation for Phase 3.** `--network devnet` lazily forks the
  real cluster, so the arena can be exercised against real mint and ATA state
  without deploying to devnet first.
- **`surfnet_setTokenAccount`** removes the mint/ATA setup dance in `before()`.
- **The sweeper's windows.** `OPEN_SWEEP_AFTER_MS` is `MAX_GAME_DURATION_MS + 1 h`
  and is currently only tested with an injected `nowMs`. Time travel would let
  it be tested against real `created_at` values on a real chain.
- **`surfnet_profileTransaction`** reports compute units, which is how you would
  find out whether `cancel_match` still fits in one transaction at 16 players.
