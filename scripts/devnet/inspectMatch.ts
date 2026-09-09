/**
 * Read a match escrow's on-chain state, by game id or by address.
 *
 *   npm run devnet:inspect -- EE96ZrfK          # a lobby's escrow
 *   npm run devnet:inspect -- --all             # every escrow this program holds
 *
 * Written for the question "the players did not get their tokens back" — which
 * is a question about the chain, and answerable from the chain alone. It is
 * read-only on purpose: it submits nothing and signs nothing, so it is safe to
 * point at a live deployment while a match is in flight.
 *
 * ⚠️ It cannot derive a PDA from a game id by itself. `deriveMatchPda` needs
 * the match *authority*, and that keypair exists only on the deployment box —
 * never here. So the lookup goes the other way: enumerate the program's
 * accounts and match on `nonce`, which IS derivable from the game id
 * (`nonceFromGameId`, duplicated below rather than imported because
 * `matchCreator.ts` pulls in the server's env and RPC plumbing).
 *
 * A game id that finds nothing is genuinely ambiguous and the output says so:
 * either no escrow was ever created for that lobby, or it settled/cancelled and
 * the sweeper has already reclaimed its rent via `close_match`.
 */
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import {
  decodeMatchAccount,
  MATCH_ACCOUNT_SIZE,
  MatchStatus,
} from "../../OpenFrontIO/src/core/arena/arenaProgram";
import { connection, PROGRAM_ID, RPC_URL } from "./common";

/** First 8 bytes of sha256(gameId) little-endian — mirrors nonceFromGameId. */
function nonceFromGameId(gameId: string): bigint {
  return createHash("sha256")
    .update(gameId, "utf8")
    .digest()
    .readBigUInt64LE(0);
}

function fmt(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals === 0 ? "" : "." + s.slice(s.length - decimals);
  return (whole + frac).replace(/\.?0+$/, "") || "0";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a.length > 0);
  const all = args.includes("--all");
  const gameId = args.find((a) => !a.startsWith("--"));

  if (!all && gameId === undefined) {
    console.error("usage: npm run devnet:inspect -- <gameId|--all>");
    process.exitCode = 1;
    return;
  }

  console.log(`rpc     ${RPC_URL}`);
  console.log(`program ${PROGRAM_ID.toBase58()}\n`);

  // dataSize alone: filtering on the discriminator too would be tighter, but
  // this program has one account type at this size and a mismatch would then
  // read as "not found" rather than as the layout drift it actually is.
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: MATCH_ACCOUNT_SIZE }],
  });
  console.log(`${accounts.length} match account(s) on this cluster\n`);

  const wanted = gameId === undefined ? null : nonceFromGameId(gameId);
  if (wanted !== null) console.log(`${gameId} -> nonce ${wanted}\n`);

  let shown = 0;
  for (const { pubkey, account } of accounts) {
    let m;
    try {
      m = decodeMatchAccount(account.data, account.owner, PROGRAM_ID);
    } catch (e) {
      console.log(`${pubkey.toBase58()}  UNDECODABLE: ${String(e)}`);
      continue;
    }
    if (wanted !== null && m.nonce !== wanted) continue;
    shown++;

    // The vault balance is the fact that answers "did they get it back": the
    // status says what the program thinks, the balance says where the money is.
    let vaultAmount = "unreadable";
    try {
      const bal = await connection.getTokenAccountBalance(m.vault);
      vaultAmount = bal.value.amount;
    } catch {
      vaultAmount = "closed or missing";
    }

    console.log(`match    ${pubkey.toBase58()}`);
    console.log(`  status      ${MatchStatus[m.status]} (${m.status})`);
    console.log(`  authority   ${m.authority.toBase58()}`);
    console.log(`  mint        ${m.mint.toBase58()}`);
    console.log(`  vault       ${m.vault.toBase58()}`);
    console.log(`  vault held  ${vaultAmount}  <- 0 means the pot has left`);
    console.log(`  entry fee   ${m.entryFee}`);
    console.log(`  rake        ${m.rakeBps} bps`);
    console.log(`  players     ${m.playerCount}/${m.maxPlayers}`);
    for (let i = 0; i < m.players.length; i++) {
      console.log(
        `    [${i}] ${m.players[i].toBase58()}  staked ${m.stakes[i]}`,
      );
    }
    const created = new Date(Number(m.createdAt) * 1000);
    const ageHours = (Date.now() - created.getTime()) / 3_600_000;
    console.log(
      `  created     ${created.toISOString()} (${ageHours.toFixed(1)}h ago)`,
    );
    console.log(`  nonce       ${m.nonce}`);

    // What a human actually needs to know next.
    if (m.status === MatchStatus.Open) {
      console.log(
        `  => stakes are still escrowed. cancel_match accepts an Open match at ` +
          `any age, so this refunds as soon as something asks it to.`,
      );
    } else if (m.status === MatchStatus.InProgress) {
      const left = 24 - ageHours;
      console.log(
        `  => filled and locked. cancel_match refuses InProgress until 24h ` +
          `after creation` +
          (left > 0
            ? ` — ${left.toFixed(1)}h to go.`
            : ` — that deadline has passed, so the sweeper can refund it now.`),
      );
    } else {
      console.log(
        `  => terminal. ${fmt(0n, 0) === "0" ? "" : ""}Vault should be 0 and rent reclaimable via close_match.`,
      );
    }
    console.log();
  }

  if (shown === 0) {
    console.log(
      wanted === null
        ? "no match accounts found."
        : `no escrow with that nonce.\n\n` +
            `That is ambiguous, deliberately:\n` +
            `  - no escrow was ever created for this lobby (nobody staked), OR\n` +
            `  - it settled or cancelled and close_match already reclaimed its rent.\n` +
            `Check the players' token balances to tell the two apart.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
