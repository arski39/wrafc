import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
// NOTE: the high-level spl-token action helpers (createMint, mintTo, ...) cannot be
// used here. They call connection.sendTransaction, and BankrunProvider's `connection`
// is a BanksClient shim, not a real web3.js Connection. Use the instruction builders
// and push them through banksClient instead.
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { Clock, ProgramTestContext } from "solana-bankrun";
import { assert } from "chai";
import nacl from "tweetnacl";
import { createHash } from "crypto";
import type { Arena } from "../target/types/arena";
import { MATCH_TIMEOUT_SECS } from "../OpenFrontIO/src/core/arena/arenaProgram";

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
//
// The honest settle path uses web3.js's Ed25519Program builder (which is what
// production sends); this stays because the adversarial tests below need
// byte-level control the canonical builder deliberately does not offer.
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

    // fromSecretKey expects a 64-byte Solana keypair; nacl gives us the same
    // 64-byte (seed || pubkey) layout.
    const serverAnchorKp = Keypair.fromSecretKey(Buffer.from(serverKp.secretKey));

    const mintKp = Keypair.generate();
    mint = mintKp.publicKey;
    treasury = Keypair.generate();

    const rent = await context.banksClient.getRent();
    const mintLamports = Number(rent.minimumBalance(BigInt(MINT_SIZE)));

    treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey);
    const p1Ata = getAssociatedTokenAddressSync(mint, player1Kp.publicKey);
    const p2Ata = getAssociatedTokenAddressSync(mint, player2Kp.publicKey);

    // Mint + ATAs + initial balances, all in one bankrun transaction.
    await sendTx(
      [
        SystemProgram.createAccount({
          fromPubkey: serverPubkey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports: mintLamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 0, serverPubkey, null),
        createAssociatedTokenAccountInstruction(serverPubkey, treasuryAta, treasury.publicKey, mint),
        createAssociatedTokenAccountInstruction(serverPubkey, p1Ata, player1Kp.publicKey, mint),
        createAssociatedTokenAccountInstruction(serverPubkey, p2Ata, player2Kp.publicKey, mint),
        createMintToInstruction(mint, p1Ata, serverPubkey, 1_000),
        createMintToInstruction(mint, p2Ata, serverPubkey, 1_000),
      ],
      serverAnchorKp,
      [serverAnchorKp, mintKp],
    );
  });

  /** Sign and process a transaction through bankrun's in-process SVM. */
  async function sendTx(
    ixs: TransactionInstruction[],
    payer: Keypair,
    signers: Keypair[],
  ): Promise<void> {
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    await context.banksClient.processTransaction(tx);
  }

  /** Read and decode an SPL token account via banksClient (not a real Connection). */
  async function getTokenAccount(address: PublicKey) {
    const raw = await context.banksClient.getAccount(address);
    if (!raw) throw new Error(`token account not found: ${address.toBase58()}`);
    return unpackAccount(
      address,
      {
        lamports: Number(raw.lamports),
        data: Buffer.from(raw.data),
        owner: new PublicKey(raw.owner),
        executable: raw.executable,
        rentEpoch: Number(raw.rentEpoch ?? 0),
      } as never,
    );
  }

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
    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);
    const winnerAta = await playerAta(winner);

    const msg = buildSettleMessage(match, winner, scores);
    const sig = nacl.sign.detached(msg, serverKp.secretKey);

    const scoresAnchored = scores.map((s) => new BN(s.toString()));
    const serverAnchorKp = Keypair.fromSecretKey(Buffer.from(serverKp.secretKey));

    await program.methods
      .settleMatch(winner, scoresAnchored)
      .accounts({
        authority: serverPubkey,
        matchAccount: match,
        vault,
        winnerToken: winnerAta,
        treasuryToken: treasuryAta,
        sysvarInstructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      // The canonical builder, which is what settler.ts sends. Its payload
      // order (pubkey before signature) differs from the hand-rolled helper
      // above, so exercising it here is what proves the program reads the
      // header offsets rather than assuming a layout.
      .preInstructions([
        anchor.web3.Ed25519Program.createInstructionWithPublicKey({
          publicKey: serverKp.publicKey,
          message: msg,
          signature: sig,
        }),
      ])
      // settle_match now requires the authority to sign as well as attest. The
      // two prove different things -- see the comment on SettleMatch.
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
    const vaultBefore = await getTokenAccount(vault);
    const pot = Number(vaultBefore.amount);
    assert.equal(pot, Number(ENTRY_FEE) * 2, "vault should hold 2 × entry_fee");

    const { winnerAta } = await doSettleMatch(nonce, player1Kp.publicKey, [200n, 100n]);

    const winnerAcct = await getTokenAccount(winnerAta);
    const treasuryAcct = await getTokenAccount(treasuryAta);

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
    const initialTreasury = await getTokenAccount(treasuryAta);
    await doSettleMatch(nonce, player2Kp.publicKey, [80n, 200n]);

    const treasuryAcct = await getTokenAccount(treasuryAta);
    const earned = Number(treasuryAcct.amount) - Number(initialTreasury.amount);
    assert.equal(earned, 10, "treasury rake should be 10 (5% of 200)");
  });

  it("double-join rejected with AlreadyJoined", async () => {
    const nonce = 12n;
    await doCreateMatch(nonce);
    await doJoinMatch(nonce, player1Kp);

    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);
    const pAta = await playerAta(player1Kp.publicKey);

    // Re-sending the *identical* transaction would be rejected as "already
    // processed" before the program ever runs, because bankrun reuses the same
    // blockhash. Submitting the same instruction with player1 as fee payer
    // makes it a distinct transaction, so the program's own AlreadyJoined
    // check is what rejects it.
    const ix = await program.methods
      .joinMatch()
      .accounts({
        player: player1Kp.publicKey,
        matchAccount: match,
        vault,
        playerToken: pAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    let threw = false;
    try {
      await sendTx([ix], player1Kp, [player1Kp]);
    } catch (e: unknown) {
      threw = true;
      const msg = `${(e as Error).message ?? ""} ${JSON.stringify(e)}`;
      // Submitting through banksClient directly bypasses Anchor's error
      // translation, so the raw custom program error code surfaces instead of
      // the variant name. AlreadyJoined is the 4th ArenaError variant, and
      // Anchor numbers custom errors from 6000: 6000 + 3 = 6003 = 0x1773.
      const isAlreadyJoined =
        msg.includes("AlreadyJoined") || msg.includes("0x1773") || msg.includes("6003");
      assert.isTrue(isAlreadyJoined, `unexpected error: ${msg}`);
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

    // Sign wrong message (empty)
    const wrongMsg = Buffer.alloc(32);
    const sig = nacl.sign.detached(wrongMsg, serverKp.secretKey);
    const ed25519Data = buildEd25519InstructionData(serverKp.publicKey, sig, wrongMsg);

    let threw = false;
    try {
      await program.methods
        .settleMatch(player1Kp.publicKey, [new BN(200), new BN(100)])
        .accounts({
          authority: serverPubkey,
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
        // Signed by the real authority on purpose, so the only thing that can
        // reject this is the digest check.
        .signers([Keypair.fromSecretKey(Buffer.from(serverKp.secretKey))])
        .rpc();
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "InvalidResultSignature", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "expected InvalidResultSignature error");
  });

  // --- cancel_match (refund path, ported from the OpenFrontIO program copy) ---

  async function doCancelMatch(
    nonce: bigint,
    stakerAtas: PublicKey[],
    signerKp?: Keypair,
  ) {
    const serverAnchorKp = Keypair.fromSecretKey(Buffer.from(serverKp.secretKey));
    const signer = signerKp ?? serverAnchorKp;
    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);

    await program.methods
      .cancelMatch()
      .accounts({
        authority: signer.publicKey,
        matchAccount: match,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      // Refund targets must be supplied in join order.
      .remainingAccounts(
        stakerAtas.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      )
      .signers([signer])
      .rpc();

    return { match, vault };
  }

  it("cancel_match refunds every staker and marks the match Cancelled", async () => {
    const nonce = 14n;
    await doCreateMatch(nonce);
    // Join only one player so the match stays Open (MAX_PLAYERS = 2).
    await doJoinMatch(nonce, player1Kp);

    const p1Ata = await playerAta(player1Kp.publicKey);
    const before = await getTokenAccount(p1Ata);

    const { match, vault } = await doCancelMatch(nonce, [p1Ata]);

    const after = await getTokenAccount(p1Ata);
    assert.equal(
      Number(after.amount) - Number(before.amount),
      Number(ENTRY_FEE),
      "staker should be refunded exactly their stake",
    );

    const vaultAcct = await getTokenAccount(vault);
    assert.equal(Number(vaultAcct.amount), 0, "vault should be drained by the refund");

    const acct = await program.account.matchAccount.fetch(match);
    assert.isTrue("cancelled" in acct.status, "match status should be Cancelled");
  });

  it("cancel_match by a non-authority is rejected with Unauthorized", async () => {
    const nonce = 15n;
    await doCreateMatch(nonce);
    await doJoinMatch(nonce, player1Kp);

    const p1Ata = await playerAta(player1Kp.publicKey);

    let threw = false;
    try {
      // player1 is a staker, not the match authority.
      await doCancelMatch(nonce, [p1Ata], player1Kp);
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "Unauthorized", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "expected Unauthorized error");
  });

  // MATCH_TIMEOUT_SECS is imported rather than restated: tests/arenaProgram.ts
  // diffs that value against the IDL, so there is one number and it is pinned.
  // The tests below still bracket the boundary -- one just under, one just over
  // -- because matching the constant is not the same as the program actually
  // enforcing the cutoff there.

  /**
   * Runs `fn` with the bank's clock pushed forward, then puts it back.
   *
   * Restoring matters: the context is shared by every test in this file, and a
   * leaked warp would silently change what "before the timeout" means for
   * whatever runs next.
   */
  async function withClockAdvancedBy<T>(
    seconds: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const before = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        before.slot,
        before.epochStartTimestamp,
        before.epoch,
        before.leaderScheduleEpoch,
        before.unixTimestamp + BigInt(seconds),
      ),
    );
    try {
      return await fn();
    } finally {
      context.setClock(before);
    }
  }

  /**
   * Mint both players enough to stake again.
   *
   * They start with 1000 and every join costs ENTRY_FEE, so a suite this long
   * exhausts them and the next join fails with FeeMismatch -- which looks
   * exactly like a bug in whatever is being tested. Tests added after the
   * originals call this rather than raising the opening balance, because the
   * early tests assert absolute amounts against it.
   */
  let topUpCount = 0;
  async function topUpPlayers(amount = 1_000) {
    const serverAnchorKp = Keypair.fromSecretKey(Buffer.from(serverKp.secretKey));
    // The counter is not cosmetic. bankrun reuses one blockhash, so an
    // identical transaction is rejected as "already processed" before it runs;
    // varying the amount by one is what keeps each top-up a distinct message.
    const each = amount + topUpCount++;
    await sendTx(
      [
        createMintToInstruction(
          mint,
          await playerAta(player1Kp.publicKey),
          serverPubkey,
          each,
        ),
        createMintToInstruction(
          mint,
          await playerAta(player2Kp.publicKey),
          serverPubkey,
          each,
        ),
      ],
      serverAnchorKp,
      [serverAnchorKp],
    );
  }

  /** Fills a match to MAX_PLAYERS, which flips it Open -> InProgress. */
  async function doFilledMatch(nonce: bigint) {
    await doCreateMatch(nonce);
    await doJoinMatch(nonce, player1Kp);
    await doJoinMatch(nonce, player2Kp);
    return {
      p1Ata: await playerAta(player1Kp.publicKey),
      p2Ata: await playerAta(player2Kp.publicKey),
    };
  }

  it("cancel_match on an in-progress match before the timeout is rejected", async () => {
    const nonce = 16n;
    const { p1Ata, p2Ata } = await doFilledMatch(nonce);

    let threw = false;
    try {
      await withClockAdvancedBy(MATCH_TIMEOUT_SECS - 60, () =>
        doCancelMatch(nonce, [p1Ata, p2Ata]),
      );
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "MatchNotTimedOut", `unexpected error: ${msg}`);
    }
    assert.isTrue(
      threw,
      "a live match must not be cancellable, or the authority could refund " +
        "out from under a game in progress",
    );
  });

  it("cancel_match on an in-progress match after the timeout refunds every staker", async () => {
    // The recovery path for a filled match whose server died: settle_match
    // needs a winner nobody can supply, so without this the pot is locked.
    const nonce = 17n;
    const { p1Ata, p2Ata } = await doFilledMatch(nonce);

    const before1 = await getTokenAccount(p1Ata);
    const before2 = await getTokenAccount(p2Ata);

    const { match, vault } = await withClockAdvancedBy(
      MATCH_TIMEOUT_SECS + 60,
      () => doCancelMatch(nonce, [p1Ata, p2Ata]),
    );

    const after1 = await getTokenAccount(p1Ata);
    const after2 = await getTokenAccount(p2Ata);
    assert.equal(
      Number(after1.amount) - Number(before1.amount),
      Number(ENTRY_FEE),
      "player1 should be refunded exactly their stake",
    );
    assert.equal(
      Number(after2.amount) - Number(before2.amount),
      Number(ENTRY_FEE),
      "player2 should be refunded exactly their stake",
    );

    const vaultAcct = await getTokenAccount(vault);
    assert.equal(Number(vaultAcct.amount), 0, "vault should be drained");

    const acct = await program.account.matchAccount.fetch(match);
    assert.isTrue("cancelled" in acct.status, "match status should be Cancelled");
  });

  it("settle_match still works after the cancel timeout has passed", async () => {
    // The timeout must be an extra escape hatch, not a deadline on settlement.
    // A server that recovers late should still be able to pay the winner.
    const nonce = 18n;
    await doFilledMatch(nonce);

    const winner = player1Kp.publicKey;
    const winnerAtaAddr = await playerAta(winner);
    const before = await getTokenAccount(winnerAtaAddr);

    const { match } = await withClockAdvancedBy(MATCH_TIMEOUT_SECS + 3600, () =>
      doSettleMatch(nonce, winner, [10n, 5n]),
    );

    const after = await getTokenAccount(winnerAtaAddr);
    assert.isAbove(
      Number(after.amount),
      Number(before.amount),
      "winner should still be paid after the timeout",
    );
    const acct = await program.account.matchAccount.fetch(match);
    assert.isTrue("settled" in acct.status, "match status should be Settled");
  });

  it("cancel_match on a settled match is rejected with NotOpen", async () => {
    // Terminal states stay terminal however long you wait -- the timeout
    // branch must apply only to InProgress, or a paid-out match could be
    // "refunded" a second time from an empty vault.
    const nonce = 19n;
    const { p1Ata, p2Ata } = await doFilledMatch(nonce);
    await doSettleMatch(nonce, player1Kp.publicKey, [10n, 5n]);

    let threw = false;
    try {
      await withClockAdvancedBy(MATCH_TIMEOUT_SECS + 60, () =>
        doCancelMatch(nonce, [p1Ata, p2Ata]),
      );
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "NotOpen", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "expected NotOpen error");
  });

  // --- adversarial: the ed25519 prelude ---------------------------------
  //
  // settle_match reads the Ed25519 precompile instruction at index 0 and trusts
  // the pubkey and message it finds at the offsets that instruction encodes.
  // Everything below attacks that reading. Each one signs with the *real*
  // authority on purpose, so the signer requirement cannot be what rejects it —
  // the only thing under test is the prelude check.

  it("rejects a prelude whose offsets point at another instruction", async () => {
    // THE ATTACK THE INSTRUCTION-INDEX CHECK EXISTS FOR.
    //
    // Ed25519SignatureOffsets carries an instruction index beside each offset.
    // Only u16::MAX means "read from this instruction"; anything else makes the
    // precompile read from a different instruction in the same transaction. So
    // an attacker points it at a second instruction holding their own key and
    // message — which verifies perfectly — while laying out the prelude's own
    // bytes so the same offsets hold the authority's pubkey and the expected
    // digest. Before the check, this settled: any player could name themselves
    // the winner and take the pot.
    const nonce = 20n;
    await topUpPlayers();
    await doFilledMatch(nonce);
    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);

    const winner = player2Kp.publicKey;
    const scores = [1n, 999n];
    const digest = buildSettleMessage(match, winner, scores);

    // ix 1 — a genuinely valid, self-referential ed25519 instruction signed by
    // the attacker over a message only they care about.
    const attackerMsg = Buffer.alloc(32, 7);
    const attackerSig = nacl.sign.detached(attackerMsg, player2Kp.secretKey);
    const decoy = buildEd25519InstructionData(
      player2Kp.publicKey.toBytes(),
      attackerSig,
      attackerMsg,
    );

    // ix 0 — the forgery. The offsets are the decoy's own layout, the indices
    // send the precompile there, and the filler sitting at those offsets here
    // is what the program reads instead.
    const SIG_OFF = 16;
    const PK_OFF = 80;
    const MSG_OFF = 112;
    const forged = Buffer.alloc(MSG_OFF + 32);
    forged[0] = 1;
    forged[1] = 0;
    forged.writeUInt16LE(SIG_OFF, 2);
    forged.writeUInt16LE(1, 4); // signature_instruction_index -> ix 1
    forged.writeUInt16LE(PK_OFF, 6);
    forged.writeUInt16LE(1, 8); // public_key_instruction_index -> ix 1
    forged.writeUInt16LE(MSG_OFF, 10);
    forged.writeUInt16LE(32, 12);
    forged.writeUInt16LE(1, 14); // message_instruction_index -> ix 1
    Buffer.from(serverKp.publicKey).copy(forged, PK_OFF);
    digest.copy(forged, MSG_OFF);

    let threw = false;
    try {
      await program.methods
        .settleMatch(winner, scores.map((x) => new BN(x.toString())))
        .accounts({
          authority: serverPubkey,
          matchAccount: match,
          vault,
          winnerToken: await playerAta(winner),
          treasuryToken: treasuryAta,
          sysvarInstructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([
          { programId: anchor.web3.Ed25519Program.programId, keys: [], data: forged },
          { programId: anchor.web3.Ed25519Program.programId, keys: [], data: decoy },
        ])
        .signers([Keypair.fromSecretKey(Buffer.from(serverKp.secretKey))])
        .rpc();
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "InvalidResultSignature", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "forged prelude must not settle the match");

    const acct = await program.account.matchAccount.fetch(match);
    assert.isTrue("inProgress" in acct.status, "match must still be InProgress");
  });

  it("rejects a prelude carrying more than one signature", async () => {
    // The program parses only the first offsets record, so a second unverified
    // one alongside it says nothing about what was attested. Refuse the shape
    // rather than reason about it.
    const nonce = 21n;
    await topUpPlayers();
    await doFilledMatch(nonce);
    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);

    const winner = player1Kp.publicKey;
    const scores = [200n, 100n];
    const digest = buildSettleMessage(match, winner, scores);
    const honestSig = nacl.sign.detached(digest, serverKp.secretKey);
    const otherMsg = Buffer.alloc(32, 3);
    const otherSig = nacl.sign.detached(otherMsg, player2Kp.secretKey);

    // Two self-referential records, both of which the precompile verifies, so
    // only the program's own num_signatures check can reject this.
    const HEADER = 2 + 14 * 2;
    const data = Buffer.alloc(HEADER + 2 * (64 + 32 + 32));
    data[0] = 2;
    const writeRecord = (
      recordAt: number,
      sigOff: number,
      pkOff: number,
      msgOff: number,
    ) => {
      data.writeUInt16LE(sigOff, recordAt);
      data.writeUInt16LE(0xffff, recordAt + 2);
      data.writeUInt16LE(pkOff, recordAt + 4);
      data.writeUInt16LE(0xffff, recordAt + 6);
      data.writeUInt16LE(msgOff, recordAt + 8);
      data.writeUInt16LE(32, recordAt + 10);
      data.writeUInt16LE(0xffff, recordAt + 12);
    };
    writeRecord(2, HEADER, HEADER + 64, HEADER + 96);
    writeRecord(16, HEADER + 128, HEADER + 192, HEADER + 224);
    Buffer.from(honestSig).copy(data, HEADER);
    Buffer.from(serverKp.publicKey).copy(data, HEADER + 64);
    digest.copy(data, HEADER + 96);
    Buffer.from(otherSig).copy(data, HEADER + 128);
    player2Kp.publicKey.toBuffer().copy(data, HEADER + 192);
    otherMsg.copy(data, HEADER + 224);

    let threw = false;
    try {
      await program.methods
        .settleMatch(winner, scores.map((x) => new BN(x.toString())))
        .accounts({
          authority: serverPubkey,
          matchAccount: match,
          vault,
          winnerToken: await playerAta(winner),
          treasuryToken: treasuryAta,
          sysvarInstructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([
          { programId: anchor.web3.Ed25519Program.programId, keys: [], data },
        ])
        .signers([Keypair.fromSecretKey(Buffer.from(serverKp.secretKey))])
        .rpc();
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "InvalidResultSignature", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "multi-signature prelude must be rejected");
  });

  it("rejects a prelude too short to hold a full offsets record", async () => {
    // 14 bytes is one field short: message_instruction_index lives at 14..16.
    // The precompile refuses this too, so the assertion is only that it does
    // not settle — the program's own length check is what keeps the reads in
    // bounds if that ever stops being true.
    const nonce = 22n;
    await topUpPlayers();
    await doFilledMatch(nonce);
    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);
    const short = Buffer.alloc(14);
    short[0] = 1;

    let threw = false;
    try {
      await program.methods
        .settleMatch(player1Kp.publicKey, [new BN(200), new BN(100)])
        .accounts({
          authority: serverPubkey,
          matchAccount: match,
          vault,
          winnerToken: await playerAta(player1Kp.publicKey),
          treasuryToken: treasuryAta,
          sysvarInstructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([
          { programId: anchor.web3.Ed25519Program.programId, keys: [], data: short },
        ])
        .signers([Keypair.fromSecretKey(Buffer.from(serverKp.secretKey))])
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "truncated prelude must be rejected");
  });

  it("rejects a settle submitted by someone other than the authority", async () => {
    // The digest names the winner but not the payout account, so without a
    // signer anyone who saw a settle transaction could rebuild it around the
    // same prelude and their own winner_token.
    const nonce = 23n;
    await topUpPlayers();
    await doFilledMatch(nonce);
    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);
    const winner = player1Kp.publicKey;
    const scores = [200n, 100n];
    const digest = buildSettleMessage(match, winner, scores);
    const sig = nacl.sign.detached(digest, serverKp.secretKey);

    let threw = false;
    try {
      await program.methods
        .settleMatch(winner, scores.map((x) => new BN(x.toString())))
        .accounts({
          authority: player2Kp.publicKey,
          matchAccount: match,
          vault,
          winnerToken: await playerAta(winner),
          treasuryToken: treasuryAta,
          sysvarInstructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: serverKp.publicKey,
            message: digest,
            signature: sig,
          }),
        ])
        .signers([player2Kp])
        .rpc();
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "Unauthorized", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "a non-authority must not be able to settle");
  });

  it("rejects a payout into a token account the winner does not own", async () => {
    const nonce = 24n;
    await topUpPlayers();
    await doFilledMatch(nonce);
    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);
    const winner = player1Kp.publicKey;
    const scores = [200n, 100n];
    const digest = buildSettleMessage(match, winner, scores);
    const sig = nacl.sign.detached(digest, serverKp.secretKey);

    let threw = false;
    try {
      await program.methods
        .settleMatch(winner, scores.map((x) => new BN(x.toString())))
        .accounts({
          authority: serverPubkey,
          matchAccount: match,
          vault,
          // Right mint, wrong owner — SPL would happily accept this transfer.
          winnerToken: treasuryAta,
          treasuryToken: treasuryAta,
          sysvarInstructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: serverKp.publicKey,
            message: digest,
            signature: sig,
          }),
        ])
        .signers([Keypair.fromSecretKey(Buffer.from(serverKp.secretKey))])
        .rpc();
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "WinnerTokenOwnerMismatch", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "payout destination must belong to the winner");
  });

  it("cancel_match refuses a refund account that is not the staker's", async () => {
    // remaining_accounts bypasses #[derive(Accounts)] entirely. Without the
    // pairing check the authority could name any token account of the right
    // mint and take every stake — the custody CLAUDE.md says it never has.
    const nonce = 25n;
    await topUpPlayers();
    await doCreateMatch(nonce);
    await doJoinMatch(nonce, player1Kp);

    let threw = false;
    try {
      await doCancelMatch(nonce, [treasuryAta]);
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "InvalidRefundAccount", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "a mismatched refund account must be rejected");

    // ...and the honest list still works, so the check is not simply refusing
    // everything.
    const p1Ata = await playerAta(player1Kp.publicKey);
    const before = await getTokenAccount(p1Ata);
    await doCancelMatch(nonce, [p1Ata]);
    const after = await getTokenAccount(p1Ata);
    assert.equal(
      Number(after.amount) - Number(before.amount),
      Number(ENTRY_FEE),
      "staker should be refunded their entry fee",
    );
  });

  // --- close_match -------------------------------------------------------

  async function doCloseMatch(nonce: bigint, signerKp?: Keypair) {
    const serverAnchorKp = Keypair.fromSecretKey(Buffer.from(serverKp.secretKey));
    const signer = signerKp ?? serverAnchorKp;
    const [match] = matchPDA(nonce);
    await program.methods
      .closeMatch()
      .accounts({
        authority: signer.publicKey,
        matchAccount: match,
        vault: vaultAta(match),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();
    return match;
  }

  it("close_match reclaims the rent from a settled match", async () => {
    const nonce = 26n;
    await topUpPlayers();
    await doFilledMatch(nonce);
    await doSettleMatch(nonce, player1Kp.publicKey, [200n, 100n]);

    const [match] = matchPDA(nonce);
    const vault = vaultAta(match);
    const before = await context.banksClient.getAccount(serverPubkey);
    await doCloseMatch(nonce);

    assert.isNull(
      await context.banksClient.getAccount(match),
      "match account should be gone",
    );
    assert.isNull(
      await context.banksClient.getAccount(vault),
      "vault should be gone",
    );
    const after = await context.banksClient.getAccount(serverPubkey);
    assert.isAbove(
      Number(after!.lamports),
      Number(before!.lamports),
      "rent should return to the authority",
    );
  });

  it("close_match is rejected while the match can still move money", async () => {
    const nonce = 27n;
    await topUpPlayers();
    await doCreateMatch(nonce);
    await doJoinMatch(nonce, player1Kp);

    let threw = false;
    try {
      await doCloseMatch(nonce);
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "MatchNotTerminal", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "an Open match must not be closable");
  });

  it("close_match by a non-authority is rejected", async () => {
    const nonce = 28n;
    await topUpPlayers();
    await doFilledMatch(nonce);
    await doSettleMatch(nonce, player1Kp.publicKey, [200n, 100n]);

    let threw = false;
    try {
      await doCloseMatch(nonce, player2Kp);
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "Unauthorized", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "only the authority may close a match");
  });

  it("close_match is rejected while the vault still holds tokens", async () => {
    // Reachable in practice: cancel_match refunds `stakes`, not the balance, so
    // a match somebody donated into keeps a residue.
    const nonce = 29n;
    await topUpPlayers();
    await doCreateMatch(nonce);
    await doJoinMatch(nonce, player1Kp);
    const p1Ata = await playerAta(player1Kp.publicKey);
    await doCancelMatch(nonce, [p1Ata]);

    const [match] = matchPDA(nonce);
    const serverAnchorKp = Keypair.fromSecretKey(Buffer.from(serverKp.secretKey));
    await sendTx(
      [createMintToInstruction(mint, vaultAta(match), serverPubkey, 5)],
      serverAnchorKp,
      [serverAnchorKp],
    );

    let threw = false;
    try {
      await doCloseMatch(nonce);
    } catch (e: unknown) {
      threw = true;
      const msg = (e as Error).message ?? "";
      assert.include(msg, "VaultNotEmpty", `unexpected error: ${msg}`);
    }
    assert.isTrue(threw, "a non-empty vault must block the close");
  });
});
