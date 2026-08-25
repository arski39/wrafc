import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection(
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  "confirmed",
);

/**
 * Confirms txSig is a transaction that touches matchPDA, giving reasonable
 * assurance the player called join_match on-chain. Full MatchAccount
 * deserialization (checking players[]) is Phase 2 once the program is deployed.
 */
export async function verifyOnchainMembership(
  matchPDA: string,
  _walletPubkey: string,
  txSig: string | undefined,
): Promise<boolean> {
  if (!txSig) return false;
  try {
    const tx = await connection.getTransaction(txSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || tx.meta?.err !== null) return false;

    const matchKey = new PublicKey(matchPDA).toString();
    const msg = tx.transaction.message;
    const accountKeys: string[] =
      "staticAccountKeys" in msg
        ? (msg.staticAccountKeys as PublicKey[]).map((k) => k.toString())
        : (msg as { accountKeys: PublicKey[] }).accountKeys.map((k) => k.toString());
    return accountKeys.includes(matchKey);
  } catch {
    return false;
  }
}
