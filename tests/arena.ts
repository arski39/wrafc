import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { ProgramTestContext } from "solana-bankrun";
import { assert } from "chai";
import nacl from "tweetnacl";
import { createHash } from "crypto";
import type { Arena } from "../target/types/arena";

// Helper: build sha256(matchPDA || winner || scores_le) matching on-chain reconstruction
function buildSettleMessage(matchPDA: PublicKey, winner: PublicKey, scores: bigint[]): Buffer {
  const h = createHash("sha256");
  h.update(matchPDA.toBuffer());
  h.update(winner.toBuffer());
  for (const s of scores) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(s);
    h.update(b);
  }
  return h.digest();
}

// Helper: build Ed25519 program instruction data for one signature
// Layout: num_sigs(1) pad(1) sig_off(2) sig_ix(2) pk_off(2) pk_ix(2) msg_off(2) msg_len(2) msg_ix(2) sig(64) pk(32) msg(N)
function buildEd25519InstructionData(pubkey: Uint8Array, sig: Uint8Array, message: Uint8Array): Buffer {
  const headerSize = 2 + (1 * 14); // 2-byte prefix + 14 bytes per sig header entry
  const sigOff = headerSize;
  const pkOff = sigOff + 64;
  const msgOff = pkOff + 32;
  const buf = Buffer.alloc(headerSize + 64 + 32 + message.length);
  buf[0] = 1; // num_signatures
  buf[1] = 0; // padding
  // offsets (u16 le)
  buf.writeUInt16LE(sigOff, 2);
  buf.writeUInt16LE(0xffff, 4); // sig_ix_index = self
  buf.writeUInt16LE(pkOff, 6);
  buf.writeUInt16LE(0xffff, 8); // pk_ix_index = self
  buf.writeUInt16LE(msgOff, 10);
  buf.writeUInt16LE(message.length, 12);
  buf.writeUInt16LE(0xffff, 14); // msg_ix_index = self
  Buffer.from(sig).copy(buf, sigOff);
  Buffer.from(pubkey).copy(buf, pkOff);
  Buffer.from(message).copy(buf, msgOff);
  return buf;
}

describe("arena", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Arena>;

  // Server keypair — authority for all matches
  const serverKp = nacl.sign.keyPair();
  const serverPubkey = new PublicKey(serverKp.publicKey);

  let mint: PublicKey;
  let treasury: Keypair;
  let treasuryAta: PublicKey;

  const ENTRY_FEE = 100n;
  const RAKE_BPS = 500; // 5 %
  const MAX_PLAYERS = 2;
  const NONCE = 1n;

  // Players
  const player1Kp = Keypair.generate();
  const player2Kp = Keypair.generate();

  before(async () => {
    context = await startAnchor(
      ".", // workspace root — Anchor.toml lives here
      [],
      [
        // Fund payer (server keypair's corresponding anchor Keypair)
        {
          address: serverPubkey,
          info: { lamports: 10_000_000_000, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false },
        },
        {
          address: player1Kp.publicKey,
          info: { lamports: 10_000_000_000, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false },
        },
        {
          address: player2Kp.publicKey,
          info: { lamports: 10_000_000_000, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false },
        },
      ],
    );
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    program = anchor.workspace.Arena as Program<Arena>;

    // Create mint (authority = server)
    const serverAnchorKp = Keypair.fromSecretKey(
      // fromSecretKey expects 64-byte Solana keypair; nacl gives us 64-byte (seed||pub) format
      Buffer.from(serverKp.secretKey),
    );
    mint = await createMint(provider.connection, serverAnchorKp, serverPubkey, null, 0);

    treasury = Keypair.generate();
    // Fund treasury for rent
    await context.banksClient; // no-op, just ensuring context is live
    treasuryAta = await createAssociatedTokenAccount(
      provider.connection,
      serverAnchorKp,
      mint,
      treasury.publicKey,
    );

    // Mint tokens to players
    const p1Ata = await createAssociatedTokenAccount(provider.connection, serverAnchorKp, mint, player1Kp.publicKey);
    const p2Ata = await createAssociatedTokenAccount(provider.connection, serverAnchorKp, mint, player2Kp.publicKey);
    await mintTo(provider.connection, serverAnchorKp, mint, p1Ata, serverAnchorKp, 1_000);
    await mintTo(provider.connection, serverAnchorKp, mint, p2Ata, serverAnchorKp, 1_000);
  });

  function matchPDA(nonce: bigint): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("match"), serverPubkey.toBuffer(), Buffer.from(new BN(nonce.toString()).toArrayLike(Buffer, "le", 8))],
      program.programId,
    );
  }

  function vaultAta(match: PublicKey): PublicKey {
    return anchor.utils.token.associatedAddress({ mint, owner: match });
  }

  async function playerAta(player: PublicKey): Promise<PublicKey> {
    return anchor.utils.token.associatedAddress({ mint, owner: player });
  }

  async function doCreateMatch(nonce: bigint) {
    const serverAnchorKp = Keypair.fromSecretKey(Buffer.from(serverKp.secretKey));
    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);
    await program.methods
      .createMatch(new BN(ENTRY_FEE.toString()), MAX_PLAYERS, RAKE_BPS, new BN(nonce.toString()))
      .accounts({
        authority: serverPubkey,
        matchAccount: match,
        vault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([serverAnchorKp])
      .rpc();
    return match;
  }

  async function doJoinMatch(nonce: bigint, playerKp: Keypair) {
    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);
    const pAta = await playerAta(playerKp.publicKey);
    await program.methods
      .joinMatch()
      .accounts({
        player: playerKp.publicKey,
        matchAccount: match,
        vault,
        playerToken: pAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([playerKp])
      .rpc();
  }

  async function doSettleMatch(nonce: bigint, winner: PublicKey, scores: bigint[]) {
    const serverAnchorKp = Keypair.fromSecretKey(Buffer.from(serverKp.secretKey));
    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);
    const winnerAta = await playerAta(winner);

    const msg = buildSettleMessage(match, winner, scores);
    const sig = nacl.sign.detached(msg, serverKp.secretKey);
    const ed25519Data = buildEd25519InstructionData(serverKp.publicKey, sig, msg);

    const scoresAnchored = scores.map((s) => new BN(s.toString()));

    await program.methods
      .settleMatch(winner, scoresAnchored)
      .accounts({
        matchAccount: match,
        vault,
        winnerToken: winnerAta,
        treasuryToken: treasuryAta,
        sysvarInstructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        {
          programId: anchor.web3.Ed25519Program.programId,
          keys: [],
          data: ed25519Data,
        },
      ])
      .signers([serverAnchorKp])
      .rpc();

    return { match, winnerAta };
  }

  it("happy path: create → join x2 → settle (winner receives pot - rake)", async () => {
    const nonce = 10n;
    await doCreateMatch(nonce);
    await doJoinMatch(nonce, player1Kp);
    await doJoinMatch(nonce, player2Kp);

    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);
    const vaultBefore = await getAccount(provider.connection, vault);
    const pot = Number(vaultBefore.amount);
    assert.equal(pot, Number(ENTRY_FEE) * 2, "vault should hold 2 × entry_fee");

    const { winnerAta } = await doSettleMatch(nonce, player1Kp.publicKey, [200n, 100n]);

    const winnerAcct = await getAccount(provider.connection, winnerAta);
    const treasuryAcct = await getAccount(provider.connection, treasuryAta);

    const expectedRake = Math.floor(pot * RAKE_BPS / 10_000);
    const expectedPayout = pot - expectedRake;

    // winner started with 1000, paid 100, so balance = 900 + payout
    assert.equal(Number(winnerAcct.amount), 900 + expectedPayout, "winner payout incorrect");
    assert.equal(Number(treasuryAcct.amount), expectedRake, "rake incorrect");
  });

  it("rake math: 500 bps on pot=200 → winner gets 190, treasury gets 10", async () => {
    const nonce = 11n;
    await doCreateMatch(nonce);
    await doJoinMatch(nonce, player1Kp);
    await doJoinMatch(nonce, player2Kp);

    // Pot = 200 (100 each), rake = 5% = 10
    const initialTreasury = await getAccount(provider.connection, treasuryAta);
    await doSettleMatch(nonce, player2Kp.publicKey, [80n, 200n]);

    const treasuryAcct = await getAccount(provider.connection, treasuryAta);
    const earned = Number(treasuryAcct.amount) - Number(initialTreasury.amount);
    assert.equal(earned, 10, "treasury rake should be 10 (5% of 200)");
  });

  it("double-join rejected with AlreadyJoined", async () => {
    const nonce = 12n;
    await doCreateMatch(nonce);
    await doJoinMatch(nonce, player1Kp);

    let threw = false;
    try {
      await doJoinMatch(nonce, player1Kp);
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "AlreadyJoined", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "expected AlreadyJoined error");
  });

  it("settle with bad server signature rejected with InvalidResultSignature", async () => {
    const nonce = 13n;
    await doCreateMatch(nonce);
    await doJoinMatch(nonce, player1Kp);
    await doJoinMatch(nonce, player2Kp);

    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);
    const winnerAta = await playerAta(player1Kp.publicKey);
    const serverAnchorKp = Keypair.fromSecretKey(Buffer.from(serverKp.secretKey));

    // Sign wrong message (empty)
    const wrongMsg = Buffer.alloc(32);
    const sig = nacl.sign.detached(wrongMsg, serverKp.secretKey);
    const ed25519Data = buildEd25519InstructionData(serverKp.publicKey, sig, wrongMsg);

    let threw = false;
    try {
      await program.methods
        .settleMatch(player1Kp.publicKey, [new BN(200), new BN(100)])
        .accounts({
          matchAccount: match,
          vault,
          winnerToken: winnerAta,
          treasuryToken: treasuryAta,
          sysvarInstructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([
          { programId: anchor.web3.Ed25519Program.programId, keys: [], data: ed25519Data },
        ])
        .signers([serverAnchorKp])
        .rpc();
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "InvalidResultSignature", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "expected InvalidResultSignature error");
  });
});
