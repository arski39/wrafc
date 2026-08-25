import crypto from "crypto";

/**
 * Commit-reveal fairness:
 * 1. At match creation, generate seed and publish sha256(seed) to clients.
 * 2. After match ends, reveal seed so anyone can reproduce orb layout.
 */
export function generateSeed(): { seed: Buffer; commitHash: string } {
  const seed = crypto.randomBytes(32);
  return { seed, commitHash: crypto.createHash("sha256").update(seed).digest("hex") };
}
