/**
 * Fund a browser test wallet: devnet SOL for fees, WARC to stake with.
 *
 *   npm run devnet:fund -- <ADDR> [<ADDR> ...]
 *
 * This exists because the browser half of validation cannot be driven from
 * here at all — `join_match` is submitted by the wallet extension, so a real
 * person with a real wallet has to press the button. What *can* be automated is
 * getting that wallet into a state where the button works, and that is three
 * separate things (SOL, an initialized token account, a WARC balance) which are
 * easy to get two-thirds right.
 *
 * Idempotent, unlike `setup.ts`: re-running tops a wallet back up rather than
 * creating anything new. Every tester needs this, and needs it again once they
 * have staked a few matches away.
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  unpackMint,
} from "@solana/spl-token";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import { deriveAta } from "../../OpenFrontIO/src/core/arena/arenaProgram";
import {
  connection,
  payer,
  RPC_URL,
  send,
  tokenBalance,
  whole,
} from "./common";

/**
 * The mint this deployment stakes in. Overridable, but defaulted so a tester
 * can be funded without first going to read the env file on the box.
 */
const MINT = new PublicKey(
  process.env.ARENA_STAKE_MINT ??
    "DhnecsQ9QKppoqcAJG3t9kPkKxcwXr3wEtZXjBGUXZkJ",
);

/**
 * Enough SOL to pay transaction fees, and nothing more.
 *
 * A tester never pays rent: their token account is created here by the payer,
 * and a winner's missing ATA is created by the server's `ensureTokenAccount()`
 * out of the match authority's balance. So this only has to cover ~5000
 * lamports per `join_match`. 0.05 SOL is hundreds of joins — sized for headroom
 * rather than need, because a wallet that runs dry mid-test looks exactly like
 * a bug in the staking flow.
 */
const SOL_TARGET = Number(process.env.TESTER_SOL ?? "0.05");

/** Tiers are 1 / 5 / 25, so this is four matches at the top tier. */
const WARC_WHOLE = BigInt(process.env.TESTER_WARC ?? "100");

/** Rent for a 165-byte token account, in SOL. Only spent when the ATA is new. */
const ATA_RENT_SOL = 0.00204;

function parseAddress(raw: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid base58 address`);
  }
}

async function main(): Promise<void> {
  // `npm run devnet:fund -- ADDR` passes the separator through on some npm
  // versions and not others.
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.length === 0) {
    throw new Error(
      "no wallet addresses given.\n  npm run devnet:fund -- <ADDR> [<ADDR> ...]",
    );
  }
  const wallets = args.map(parseAddress);

  const kp = payer();
  console.log(`rpc      ${RPC_URL}`);
  console.log(`mint     ${MINT.toBase58()}`);
  console.log(`payer    ${kp.publicKey.toBase58()}`);

  // Read the mint once, and read the AUTHORITY from it, not just the decimals.
  // `createMintToInstruction` signed by the wrong key fails with a bare
  // `custom program error: 0x4` (OwnerMismatch), which says nothing about
  // which of the two keys in play was wrong.
  //
  // `unpackMint` is a pure decoder, so the ban on @solana/spl-token's action
  // helpers does not apply — that ban is on the ones calling
  // `connection.sendTransaction`.
  const mint = unpackMint(MINT, await connection.getAccountInfo(MINT));
  if (mint.mintAuthority === null) {
    throw new Error(`${MINT.toBase58()} has no mint authority — cannot mint`);
  }
  if (!mint.mintAuthority.equals(kp.publicKey)) {
    throw new Error(
      `the payer is not this mint's authority.\n` +
        `  mint authority  ${mint.mintAuthority.toBase58()}\n` +
        `  payer           ${kp.publicKey.toBase58()}\n` +
        `Point DEVNET_PAYER_KEYPAIR at the keypair that created the mint.`,
    );
  }
  console.log(`decimals ${mint.decimals}`);

  // Work out what every wallet is missing before spending anything, so a payer
  // that cannot cover the whole batch fails before half-funding it.
  const plan = await Promise.all(
    wallets.map(async (wallet) => {
      const ata = deriveAta(wallet, MINT);
      const [lamports, ataInfo] = await Promise.all([
        connection.getBalance(wallet),
        connection.getAccountInfo(ata),
      ]);
      return {
        wallet,
        ata,
        lamports,
        ataExists: ataInfo !== null,
        solShortfall: Math.max(
          0,
          Math.round(SOL_TARGET * LAMPORTS_PER_SOL) - lamports,
        ),
      };
    }),
  );

  const needed =
    plan.reduce((n, p) => n + p.solShortfall, 0) +
    plan.filter((p) => !p.ataExists).length * ATA_RENT_SOL * LAMPORTS_PER_SOL +
    plan.length * 10_000; // one transaction each, plus slack
  const held = await connection.getBalance(kp.publicKey);
  console.log(
    `balance  ${(held / 1e9).toFixed(4)} SOL, this batch needs ~${(
      needed / 1e9
    ).toFixed(4)}`,
  );
  if (held < needed) {
    throw new Error(
      `payer is short by ${((needed - held) / 1e9).toFixed(4)} SOL. ` +
        `Top up ${kp.publicKey.toBase58()} at faucet.solana.com (devnet).`,
    );
  }

  for (const p of plan) {
    console.log(`\n${p.wallet.toBase58()}`);

    // One transaction per wallet: SOL, the token account and the tokens
    // together. Partly fewer round-trips against an endpoint that 429s, and
    // partly so a wallet is never left holding SOL but no token account — a
    // state in which the stake prompt fails in a way that reads like the
    // integration is broken rather than like a half-finished top-up.
    const ixs: TransactionInstruction[] = [];
    if (p.solShortfall > 0) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: p.wallet,
          lamports: p.solShortfall,
        }),
      );
      console.log(
        `  + ${(p.solShortfall / 1e9).toFixed(4)} SOL (had ${(
          p.lamports / 1e9
        ).toFixed(4)})`,
      );
    } else {
      console.log(`  = ${(p.lamports / 1e9).toFixed(4)} SOL, already funded`);
    }
    // Idempotent: a wallet that has staked before already has this account,
    // and a plain create would abort the whole transaction on a second run.
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        kp.publicKey,
        p.ata,
        p.wallet,
        MINT,
      ),
    );
    ixs.push(
      createMintToInstruction(
        MINT,
        p.ata,
        kp.publicKey,
        whole(WARC_WHOLE, mint.decimals),
      ),
    );

    const sig = await send(ixs, [kp]);
    const balance = await tokenBalance(p.ata);
    console.log(`  + ${WARC_WHOLE} WARC -> ${p.ata.toBase58()}`);
    console.log(`  = ${Number(balance) / 10 ** mint.decimals} WARC held`);
    console.log(`  tx ${sig}`);
  }

  console.log(`
────────────────────────────────────────────────────────────────────────
Funded. Each wallet must be switched to DEVNET in the extension, or the
balances read as zero and the stake prompt fails with nothing to stake:

  Phantom   Settings -> Developer Settings -> Testnet Mode -> Solana Devnet
  Solflare  network dropdown, top right -> Devnet

Wagered lobbies stay private-only until ARENA_PUBLIC_WAGER_LOBBIES is on,
so the host creates a PRIVATE lobby and shares the join link.
────────────────────────────────────────────────────────────────────────
`);
}

main().catch((e: unknown) => {
  console.error(
    `\nfunding failed: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exitCode = 1;
});
