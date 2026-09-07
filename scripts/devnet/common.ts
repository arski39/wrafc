/**
 * Shared plumbing for the devnet scripts.
 *
 * Lifted in shape from `tests/surfpool/timeout.ts`, with two deliberate
 * differences, both forced by devnet being a real, shared, never-reset cluster:
 *
 *  1. **No `requestAirdrop`.** The surfpool suite airdrops 5 SOL per keypair.
 *     Devnet's faucet caps around 2 SOL per request with per-IP cooldowns, and
 *     three fresh keypairs would exhaust it before the first assertion. Test
 *     wallets are funded by `SystemProgram.transfer` from one pre-funded payer.
 *
 *  2. **No `surfnet_timeTravel`.** It is a Surfpool cheatcode and exists
 *     nowhere else, so the 24-hour `MATCH_TIMEOUT_SECS` branch of
 *     `cancel_match` is **not reachable here**. That branch stays surfpool-only;
 *     devnet exercises the `Open` cancel path, which the program accepts at any
 *     age.
 *
 * Everything reads through the **production** bindings in
 * `OpenFrontIO/src/core/arena/arenaProgram.ts` — the same module the server and
 * the browser ship. A harness with its own decoder would prove nothing about
 * the code that actually runs.
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import {
  decodeMatchAccount,
  decodeMintAccount,
} from "../../OpenFrontIO/src/core/arena/arenaProgram";

export const RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

export const PROGRAM_ID = new PublicKey(
  process.env.ARENA_PROGRAM_ID ??
    "4CGRLB5WJ4LK4nqwhzN5uhU78cakuHzG5wfrUZrQ2G64",
);

/** Confirmed, not finalized: finalized adds ~13s per step for no extra proof here. */
export const connection = new Connection(RPC_URL, "confirmed");

/**
 * The wallet that pays for everything.
 *
 * Defaults to the Solana CLI's keypair, which is also the program's deployer
 * and (per scripts/devnet/setup.ts) the stake mint's mint authority. It is
 * deliberately NOT the server's match authority: that one is generated on the
 * deployment box and must never exist anywhere else.
 */
export function payer(): Keypair {
  const p =
    process.env.DEVNET_PAYER_KEYPAIR ??
    path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(p)) {
    throw new Error(
      `no payer keypair at ${p}. Set DEVNET_PAYER_KEYPAIR, or run ` +
        `\`solana-keygen new\` and fund it at faucet.solana.com.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
  if (raw.length !== 64) {
    throw new Error(`${p} must contain a 64-byte JSON array, got ${raw.length}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export async function send(
  ixs: TransactionInstruction[],
  signers: Signer[],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

/** Moves SOL from the payer. See (1) in the module comment for why not airdrop. */
export async function fundFromPayer(
  from: Keypair,
  to: PublicKey,
  sol: number,
): Promise<void> {
  await send(
    [
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: to,
        lamports: Math.round(sol * LAMPORTS_PER_SOL),
      }),
    ],
    [from],
  );
}

/**
 * Raw balance read at offset 64 of an SPL token account.
 *
 * Not `getAccount` from @solana/spl-token — matching the surfpool suite's
 * idiom, and one fewer thing that can disagree with the program's own view.
 * A missing account reads 0 rather than throwing, which is what S7 needs.
 */
export async function tokenBalance(account: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(account);
  if (info === null) return 0n;
  return Buffer.from(info.data).readBigUInt64LE(64);
}

/** Reads a match through the production decoder, owner and discriminator checks included. */
export async function readMatch(pda: PublicKey) {
  const info = await connection.getAccountInfo(pda);
  if (info === null) throw new Error(`match account ${pda.toBase58()} not found`);
  return decodeMatchAccount(info.data, info.owner, PROGRAM_ID);
}

export async function mintDecimals(mint: PublicKey): Promise<number> {
  const info = await connection.getAccountInfo(mint);
  if (info === null) throw new Error(`no mint at ${mint.toBase58()}`);
  return decodeMintAccount(info.data, info.owner).decimals;
}

/**
 * A nonce nothing else will reuse.
 *
 * **Mandatory on devnet, not a nicety.** The match PDA is seeded on this, and
 * devnet is never reset, so a fixed nonce collides with the previous run's
 * account and `init` fails with an error that looks nothing like the cause.
 */
export function freshNonce(): bigint {
  return BigInt(Date.now()) & 0xffffffffffffn;
}

export async function assertProgramDeployed(): Promise<void> {
  const info = await connection.getAccountInfo(PROGRAM_ID);
  if (info?.executable !== true) {
    throw new Error(
      `${PROGRAM_ID.toBase58()} is not an executable account on ${RPC_URL}.\n` +
        `Deploy it first:\n` +
        `  solana program deploy --url devnet \\\n` +
        `    --program-id target/deploy/arena-keypair.json target/deploy/arena.so`,
    );
  }
}

/** Base units for a whole-token amount at this mint's decimals. */
export function whole(amount: bigint, decimals: number): bigint {
  return amount * 10n ** BigInt(decimals);
}
