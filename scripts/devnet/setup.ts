/**
 * One-time devnet setup: the stake mint and the rake destination.
 *
 * Run once after `solana program deploy`, then paste the printed block into the
 * deployment's env file. Re-running creates a *new* mint — it is not
 * idempotent, on purpose, because silently reusing a mint you have forgotten
 * the authority for is worse than an obvious duplicate.
 *
 *   npx ts-node --project tsconfig.json scripts/devnet/setup.ts
 *
 * Every constraint below is enforced at server boot by
 * `OpenFrontIO/src/server/arena/stakeMint.ts`; this script exists so the mint
 * satisfies them by construction rather than by luck.
 */
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  PROGRAM_ID,
  RPC_URL,
  assertProgramDeployed,
  connection,
  payer,
  send,
  tokenBalance,
  whole,
} from "./common";
import { deriveAta } from "../../OpenFrontIO/src/core/arena/arenaProgram";

/**
 * 6, matching USDC.
 *
 * The hard ceiling is 9 (`MAX_STAKE_MINT_DECIMALS`), and the arithmetic ceiling
 * is 17 — at 18, tier 25 is `25 * 10^18`, which overflows a u64 and throws
 * inside `buildCreateMatchIx`, i.e. a 502 on a live lobby rather than a boot
 * refusal.
 */
const DECIMALS = 6;

/** Enough to hand out to test wallets many times over. Tiers are 1 / 5 / 25. */
const INITIAL_SUPPLY_WHOLE = 1_000_000n;

async function main(): Promise<void> {
  const kp = payer();
  console.log(`rpc      ${RPC_URL}`);
  console.log(`program  ${PROGRAM_ID.toBase58()}`);
  console.log(`payer    ${kp.publicKey.toBase58()}`);

  await assertProgramDeployed();

  const balance = await connection.getBalance(kp.publicKey);
  console.log(`balance  ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.1e9) {
    throw new Error(
      `payer holds ${(balance / 1e9).toFixed(4)} SOL, which will not cover the ` +
        `mint and token accounts. Top up at faucet.solana.com (devnet).`,
    );
  }

  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const treasury = deriveAta(kp.publicKey, mint);
  const payerAta = treasury; // same account: the payer is also the rake owner
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  console.log(`\ncreating mint ${mint.toBase58()} ...`);
  const sig = await send(
    [
      SystemProgram.createAccount({
        fromPubkey: kp.publicKey,
        newAccountPubkey: mint,
        space: MINT_SIZE,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      // Legacy SPL Token, not Token-2022: the arena pins Program<'info, Token>,
      // so a Token-2022 mint can never be escrowed. It also means transfer-fee
      // and transfer-hook extensions cannot apply here.
      //
      // freezeAuthority is null DELIBERATELY. One mint serves the whole
      // deployment, so a freeze turns a per-lobby risk into a global one: a
      // frozen vault or player token account fails BOTH settle_match and
      // cancel_match, and the 24h timeout does not help, because it is the
      // transfer itself that fails. stakeMint.ts warns rather than refusing —
      // we simply do not create one.
      createInitializeMint2Instruction(mint, DECIMALS, kp.publicKey, null),
      createAssociatedTokenAccountInstruction(
        kp.publicKey,
        payerAta,
        kp.publicKey,
        mint,
      ),
      createMintToInstruction(
        mint,
        payerAta,
        kp.publicKey,
        whole(INITIAL_SUPPLY_WHOLE, DECIMALS),
      ),
    ],
    [kp, mintKp],
  );
  console.log(`  tx ${sig}`);

  const held = await tokenBalance(payerAta);
  console.log(`  minted ${held} base units to ${payerAta.toBase58()}`);

  console.log(`
────────────────────────────────────────────────────────────────────────
Paste into the deployment env file:

ARENA_STAKE_MINT=${mint.toBase58()}
ARENA_STAKE_SYMBOL=WARC
TREASURY_TOKEN_ACCOUNT=${treasury.toBase58()}
────────────────────────────────────────────────────────────────────────

Notes:

  * TREASURY_TOKEN_ACCOUNT is only read when ARENA_RAKE_BPS > 0, and it is
    checked at boot for THIS mint. A treasury holding a different mint is
    refused there rather than at settlement, where the rake transfer would
    fail and take the whole settlement down with it, stranding the pot.

  * The rake destination is recorded on each match at create_match, so
    settle_match refuses any other account. Changing this variable later
    affects only matches created afterwards; live escrows keep paying the
    treasury they were made with. That is the point, not a limitation.

  * The mint authority is the payer (${kp.publicKey.toBase58()}).
    Keep that keypair — it is the only way to mint test tokens to players.
    It is NOT the match authority, which lives only on the deployment box.
`);
}

main().catch((e: unknown) => {
  console.error(`\nsetup failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
