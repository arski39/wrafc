# Devnet setup and live validation (Phase 3)

The on-chain half of Phase 3, scripted so it is repeatable rather than a session
of CLI archaeology. Run from **WSL** — the root `node_modules` is installed
there, so the `.bin` shims are Linux ones and Windows fails with
`'ts-mocha' is not recognized`.

## Order

```bash
# 1. deploy the program (keeps the upgrade authority)
solana program deploy --url devnet \
  --program-id target/deploy/arena-keypair.json target/deploy/arena.so
solana program show 4CGRLB5WJ4LK4nqwhzN5uhU78cakuHzG5wfrUZrQ2G64 --url devnet

# 2. create the stake mint and the rake destination
npm run devnet:setup          # prints the env block to paste

# 3. assert S1-S7 against it
export ARENA_STAKE_MINT=...
export TREASURY_TOKEN_ACCOUNT=...
export ARENA_RAKE_BPS=250
npm run test:devnet
```

The payer defaults to the Solana CLI keypair (`~/.config/solana/id.json`);
override with `DEVNET_PAYER_KEYPAIR`. It needs SOL — the faucet CLI is
rate-limited, so use **faucet.solana.com**.

## What each file is

|                |                                                                         |
| -------------- | ----------------------------------------------------------------------- |
| `common.ts`    | Connection, payer, `send`, `tokenBalance`, `readMatch`, nonce           |
| `setup.ts`     | Creates the mint (6 decimals, no freeze authority) and the treasury ATA |
| `scenarios.ts` | S1–S7 as a mocha suite                                                  |

Everything reads through the **production** bindings in
`OpenFrontIO/src/core/arena/arenaProgram.ts` — the same module the server and
the browser ship, including `decodeMatchAccount`. A harness with its own decoder
would prove nothing about the code that actually runs.

## Two differences from `tests/surfpool/`, both forced by devnet being real

**No `requestAirdrop`.** The surfpool suite airdrops 5 SOL per keypair. Devnet's
faucet caps around 2 SOL with per-IP cooldowns, and three fresh keypairs would
exhaust it before the first assertion. Test wallets are funded by
`SystemProgram.transfer` from one pre-funded payer.

**No `surfnet_timeTravel`.** It is a Surfpool cheatcode and exists nowhere else,
so **S5's `InProgress` branch — the 24-hour `MATCH_TIMEOUT_SECS` refund — is not
reachable here.** That branch stays in `tests/surfpool/timeout.ts`. What S5
covers on devnet is the `Open` cancel path, which the program accepts at any age
and which is the one an abandoned lobby actually takes.

## The nonce is mandatory here

`freshNonce()` derives from `Date.now()`. The match PDA is seeded on it and
**devnet is never reset**, so a fixed nonce collides with the previous run's
account and `init` fails with an error that looks nothing like the cause.

## What is covered

|       |                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------- |
| S1    | Created match is `Open`; fee, rake, mint, authority and **treasury** as configured                                  |
| S2    | Two stakes → `InProgress`, vault holds the pot, `players[]` in join order                                           |
| S3+S4 | Winner paid `pot − rake`, rake exactly `pot × bps / 10000`, vault empties, `close_match` returns both rents         |
| S5    | `Open` cancel refunds exactly the stake                                                                             |
| S5b   | A refund account not owned by `players[i]` is refused                                                               |
| S6    | A digest the program will not recompute is rejected, pot untouched                                                  |
| S6b   | A settle redirecting the rake to another account is refused                                                         |
| S7    | A winner who staked from a **non-ATA** token account is paid after `ensureTokenAccount` creates their canonical ATA |

S7 is the real shape of that case: `join_match` checks only `owner` and `mint`,
not canonical ATA derivation, so a player can legitimately stake from a plain
token account and never have an ATA. `settle_match` will not create one — it
checks `winner_token.owner == winner` and stops — so without the prior
`ensureTokenAccount` transaction the payout fails with the pot already in the
vault.

## What this does not cover

The server's half: the wagered start gate, the replay verifier, the settler's
own refusals. Those are vitest suites in `OpenFrontIO/tests/server/`. This file
is the program's half, against a real cluster.

## The authority here is a throwaway

`scenarios.ts` generates a fresh keypair for the match authority rather than
using the server's. The production authority is generated **on the deployment
box** and must never exist anywhere else. The program cannot tell the difference
— `authority` is simply whoever signed `create_match`.

## `inspectMatch.ts` — reading a live escrow (ops, not a test)

```bash
npm run devnet:inspect -- EE96ZrfK     # one lobby's escrow
npm run devnet:inspect -- --all        # every escrow this program holds
```

Read-only: it submits nothing and signs nothing, so it is safe to point at the
live deployment mid-match. Written for the only question that matters when a
game goes wrong — _where are the stakes_ — and it answers it from the chain
alone, which is the same reason the sweeper works: chain state survives
everything the server does not.

**It cannot derive a PDA from a game id.** `deriveMatchPda` needs the match
authority, and that keypair exists only on the box. So the lookup runs the other
way — enumerate the program's accounts, match on `nonce`, which _is_ derivable
from the game id. That is also why `--all` is the useful mode when you do not
know which lobby you are looking for.

It prints the vault's token balance next to the status deliberately. The status
is what the program believes; the balance is where the money actually is, and a
`Settled` match with a non-empty vault is a different problem from a `Settled`
match with an empty one.

**A game id that finds nothing is ambiguous, and the output says so:** either no
escrow was ever created for that lobby, or it reached a terminal state and
`close_match` has already reclaimed its rent. Only the players' token balances
separate those two.
