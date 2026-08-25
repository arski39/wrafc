import crypto from "crypto";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

const AUTH_PREFIX = "Orb Arena\nAuth: "; // must match client walletAuth

export function genNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function verifyWalletSig(
  nonce: string,
  walletPubkey: string,
  sigBase64: string,
): boolean {
  try {
    const message = new TextEncoder().encode(AUTH_PREFIX + nonce);
    const pubkeyBytes = new PublicKey(walletPubkey).toBytes();
    const sigBytes = new Uint8Array(Buffer.from(sigBase64, "base64"));
    return nacl.sign.detached.verify(message, sigBytes, pubkeyBytes);
  } catch {
    return false;
  }
}
