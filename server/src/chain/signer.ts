import nacl from "tweetnacl";
import fs from "fs";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";

let _keypair: nacl.SignKeyPair | null = null;

function keypair(): nacl.SignKeyPair {
  if (!_keypair) {
    const raw = JSON.parse(
      fs.readFileSync(process.env.SERVER_KEYPAIR_PATH!, "utf8"),
    ) as number[];
    _keypair = nacl.sign.keyPair.fromSecretKey(new Uint8Array(raw));
  }
  return _keypair;
}

/** Signs sha256(matchPDA_bytes || winner_bytes || scores_le_bytes) with the server keypair. */
export function signMatchResult(
  matchPDA: string,
  winner: string,
  scores: number[],
): Uint8Array {
  const matchBytes = new PublicKey(matchPDA).toBuffer();
  const winnerBytes = new PublicKey(winner).toBuffer();
  const scoresBytes = Buffer.concat(
    scores.map((s) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(Math.round(s)));
      return b;
    }),
  );
  const digest = createHash("sha256")
    .update(matchBytes)
    .update(winnerBytes)
    .update(scoresBytes)
    .digest();
  return nacl.sign.detached(digest, keypair().secretKey);
}

export function serverPubkey(): Uint8Array {
  return keypair().publicKey;
}
