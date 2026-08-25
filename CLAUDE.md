# CLAUDE.md — Orb Arena (Solana Skill-Based .io Game)

## Project Overview
A skill-based wagering game inspired by agar.io. Players stake SPL tokens into an
on-chain escrow, play a match on an authoritative game server, and the winner is
paid out from escrow by a Solana program that verifies a server signature.

Three components:
1. `programs/arena/` — Anchor program (escrow: create_match, join_match, settle_match)
2. `server/` — Node/TS authoritative game server (game loop + WebSocket + result signing)
3. `client/` — PixiJS browser client (Vite) with Solana wallet-adapter

## Hard Rules
- NEVER trust the client: all movement/collision simulation happens server-side.
  Clients send only input direction vectors and sequence numbers.
- All wager logic must live in the Anchor program. The server NEVER holds user funds.
- Match results are signed ed25519 by the server keypair (`server/src/chain/signer.ts`).
  Settlement must verify this signature before paying out.
- Determinism: orb spawns come from a committed seed (commit-reveal in
  `server/src/fairness/seedCommit.ts`). Never use Math.random() for anything
  gameplay-affecting on the server.
- Keep TypeScript strict (`strict: true` in both tsconfigs). No `any` in new code
  except WebSocket message parsing boundaries — type those with discriminated unions.
- Do not add new dependencies without stating why in the commit message.

## Current State (do not re-do)
- Anchor program skeleton exists: create_match / join_match / settle_match.
  Known gaps: vault token account init not wired; settle does NOT yet verify
  the ed25519 signature on-chain (has a TODO comment).
- Server has: fixed-timestep loop, World/Player/Orb sim, snapshot broadcast,
  naive matchmaking queue, match end → sign result. Wallet auth is stubbed
  ("player_" random ids).
- Client has: PixiJS canvas, socket connect/join_queue/snapshot rendering,
  mouse-direction input. No wallet integration, no interpolation, no camera.

## Task Queue — work in this order

### PHASE 1: Wallet Auth + On-chain Join (highest priority)
1. Add Phantom/Solflare via @solana/wallet-adapter to client (`client/src/ui/Lobby.ts`
   is the placeholder). Flow:
   - User connects wallet → signs a nonce message (SIWS-style) over WS
   - Server verifies signature (tweetnacl), binds WS session to wallet pubkey
   - Reject any join_queue from unauthenticated sessions
2. Replace `"player_" + Math.random()` ids in `server/src/index.ts` with the
   verified wallet pubkey.
3. Client calls `join_match` on-chain before sending `join_queue`; server should
   verify membership on-chain (read MatchAccount via RPC) OR accept a tx
   signature it confirms — choose RPC read approach (simpler).
4. Gate `tryStartMatch()` so every queued player has paid entry fee on-chain.

### PHASE 2: Fix the Anchor Program
5. Initialize the vault as a PDA-owned Associated Token Account inside
   `create_match` (use anchor-spl `token::CreateAssociatedTokenAccount` or init_if_needed).
6. Implement real on-chain ed25519 signature verification in `settle_match`.
   Recommended: pass the Ed25519Program instruction as an extra account/instruction
   in the same tx and verify via `load_instruction_at` / `get_processed_sibling_instruction`,
   or integrate `spl-ed25519`. Verify: sig covers sha256(match_key || winner || scores)
   exactly as produced by `server/src/chain/signer.ts`.
7. Write tests in `programs/arena/tests/arena.ts` using anchor-bankrun or solana-bankrun:
   - happy path create→join x3→settle
   - double-join rejected
   - settle with bad signature rejected
   - rake math correct (95/5 at 500 bps)

### PHASE 3: Game Feel
8. Camera: follow player, zoom scales inversely with radius (PixiJS container scale).
9. Smooth interpolation: keep last two snapshots per entity, lerp positions at render
   time using tick timestamps. Current code snaps to latest snapshot.
10. Split mechanic: spacebar splits mass in half toward cursor (agar.io style),
    cooldown 2s, min split mass 40. Implement SERVER-side in World.step first,
    then client input.
11. Death handling: when eaten, send `you_died` message; spectator mode until match end.
12. Orb rendering with colors + player names as Pixi Text labels.

### PHASE 4: Hardening
13. Rate-limit WS messages per connection (max ~30 input msgs/sec, drop excess).
14. Input sanity: clamp |dx,dy| magnitude, ignore seq <= lastSeq (already done),
    kick clients sending malformed payloads.
15. Reconnect handling: if a paid player disconnects mid-match, their cell idles
    (drifts straight) — do NOT refund mid-match; document this behavior.
16. Persist match history (SQLite is fine) for leaderboards + dispute audits.

## Conventions
- Commits: conventional commits (`feat(server):`, `fix(program):`, etc.)
- One phase = one PR-sized chunk of work. Finish + test before moving on.
- Run checks before declaring done:
  - Program: `anchor build && anchor test`
  - Server: `npx tsc --noEmit`
  - Client: `npx tsc --noEmit && vite build`
- Never commit keypairs. `.env` and any `*.json` keypair files must be gitignored.
- When touching settlement math, add/update a bankrun test in the same change.

## Environment Variables
- server/.env: PORT, SOLANA_RPC_URL, SERVER_KEYPAIR_PATH, PROGRAM_ID, TREASURY_TOKEN_ACCOUNT
- client/.env: VITE_WS_URL, VITE_SOLANA_CLUSTER (devnet), VITE_PROGRAM_ID
