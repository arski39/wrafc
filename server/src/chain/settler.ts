// Wires signed match results into the on-chain settle_match instruction.
// Full Anchor client integration in Phase 2; stubbed here.
export async function settleMatch(
  matchKey: string,
  winner: string,
  scores: Record<string, number>,
  sig: Uint8Array,
): Promise<void> {
  console.log(`[settler] match=${matchKey} winner=${winner} sig=${Buffer.from(sig).toString("hex").slice(0, 16)}…`);
  // TODO: build and send settle_match tx via @coral-xyz/anchor
}
