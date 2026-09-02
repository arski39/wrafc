# Vendored — solana-foundation/solana-dev-skill

| | |
|---|---|
| Source | https://github.com/solana-foundation/solana-dev-skill |
| Version | 2.4.0 (`SKILL.md` frontmatter) |
| Commit | `718f7cd92b588cda6940ec9dbb37906df463e3cd`, 2026-09-02 |
| Licence | MIT — see `LICENSE` |
| Vendored | 2026-09-02 |

Copied in rather than installed with `npx skills add`, so the version is pinned,
reviewable in the diff, and available offline. Only `skills/solana-dev/` and the
licence are taken; the upstream repo's README, banner, installer and tests are
not.

To update: re-download the tree at a newer tag, replace this directory, and
update the table above. Read the diff — this is third-party content that steers
how an agent writes code against a program that moves real tokens.

## Its stack advice is deliberately NOT followed here

The skill is Kit-first and Anchor-1.1-first. This project is not, on purpose.
Read it for the parts below, and see the root `CLAUDE.md` for the full table.

| Skill says | This project |
|---|---|
| Anchor 1.1.x | **0.31.1.** `CLAUDE.md` records how much was burned getting 0.31.1 + Agave 4.2.1 to build at all. Revisit after Phase 3, not before. |
| `@solana/kit` v7; avoid web3.js v1 | **web3.js v1**, with hand-rolled instruction bindings in `OpenFrontIO/src/core/arena/arenaProgram.ts`. That module ships to the browser, and avoiding a large client dep is why it exists. Kit's tree-shaking is a real future win for the 294 kB `wagerJoinFlow` chunk — a spike, not a mandate. |
| Surfpool as the test runner | **bankrun**, which pins the bindings and the decoder across 42 tests. Surfpool is used *alongside* it for what bankrun cannot do — a really-deployed program and time travel. |
| `@solana/react` + Wallet Standard | `OpenFrontIO/src/client/arena/WalletProvider.ts`. The migration target if wallet support ever widens. |

## What it was actually used for

Its `references/security.md` checklist, applied to `programs/arena/`, is what
surfaced the ed25519 instruction-index bypass in `settle_match` and the
unvalidated `remaining_accounts` in `cancel_match`. Neither finding is a quote
from the skill — it does not cover ed25519 introspection at all — but its
"unvalidated remaining_accounts", "TOCTOU / bait-and-switch" and "frontrunning"
entries are what prompted looking.

Its `W011` rule (validate owner, length and discriminator before deserializing
anything from chain) is already what `decodeMatchAccount` does. Independent
confirmation, not a change.
