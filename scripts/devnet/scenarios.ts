/**
 * Phase 3 — S1..S7 asserted on-chain, against a really-deployed program on
 * devnet.
 *
 *   npm run test:devnet
 *
 * Requires ARENA_STAKE_MINT and TREASURY_TOKEN_ACCOUNT from
 * `scripts/devnet/setup.ts`, and a payer with SOL and mint authority.
 *
 * WHAT THIS PROVES THAT BANKRUN AND SURFPOOL DO NOT
 *
 * bankrun loads arena.so into an in-process SVM: fast, hermetic, and not a
 * deploy. Surfpool proves the program deploys and reaches its 24-hour timeout
 * via a cheatcode. Neither runs against a real cluster, so neither can catch
 * RPC latency, real confirmation ordering, blockhash expiry, or a provider
 * mishandling the ed25519 precompile.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER
 *
 * S5's `InProgress` branch — the 24-hour `MATCH_TIMEOUT_SECS` refund — is
 * unreachable here: `surfnet_timeTravel` is a Surfpool cheatcode and exists
 * nowhere else. That branch stays in `tests/surfpool/timeout.ts`. What S5 covers
 * here is the `Open` cancel path, which the program accepts at any age and
 * which is the one an abandoned lobby actually takes.
 *
 * The server half — the start gate, the replay verifier, the settler's own
 * decision-making — is covered by the vitest suites in OpenFrontIO. This file
 * is the program's half.
 */
import { createHash } from "crypto";
import { assert } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeAccount3Instruction,
  createMintToInstruction,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import {
  MatchStatus,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  buildCancelMatchIx,
  buildCloseMatchIx,
  buildCreateAtaIdempotentIx,
  buildCreateMatchIx,
  buildEd25519VerifyIx,
  buildJoinMatchIx,
  buildSettleMatchIx,
  deriveAta,
  settleMessagePreimage,
} from "../../OpenFrontIO/src/core/arena/arenaProgram";
import {
  PROGRAM_ID,
  RPC_URL,
  assertProgramDeployed,
  connection,
  freshNonce,
  fundFromPayer,
  mintDecimals,
  payer,
  readMatch,
  send,
  tokenBalance,
  whole,
} from "./common";

const RAKE_BPS = Number(process.env.ARENA_RAKE_BPS ?? "250");

describe("devnet: S1-S7 against a deployed program", function () {
  // Devnet confirmations are seconds, not microseconds, and there are dozens.
  this.timeout(600_000);

  const funder = payer();
  /**
   * Stands in for the server's match authority.
   *
   * Deliberately a fresh throwaway rather than the real one: the production
   * authority is generated on the deployment box and must never exist here.
   * The program cannot tell the difference — `authority` is whoever signed
   * `create_match`.
   */
  const authority = Keypair.generate();
  const players = [Keypair.generate(), Keypair.generate()];

  let mint: PublicKey;
  let treasury: PublicKey;
  let decimals: number;
  let entryFee: bigint;
  let playerAtas: PublicKey[];

  // ------------------------------------------------------------------ helpers

  /** Creates a match and fills it, returning everything the assertions need. */
  async function openMatch(): Promise<{
    matchPda: PublicKey;
    vault: PublicKey;
  }> {
    const created = buildCreateMatchIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      mint,
      entryFee,
      maxPlayers: 2,
      rakeBps: RAKE_BPS,
      // Mandatory on devnet: the PDA is seeded on it and devnet is never reset,
      // so a fixed nonce collides with the previous run's account.
      nonce: freshNonce(),
      treasury: RAKE_BPS > 0 ? treasury : undefined,
    });
    await send([created.ix], [authority]);
    return { matchPda: created.matchPda, vault: created.vault };
  }

  async function fill(matchPda: PublicKey, vault: PublicKey): Promise<void> {
    for (const [i, player] of players.entries()) {
      await send(
        [
          buildJoinMatchIx({
            programId: PROGRAM_ID,
            player: player.publicKey,
            matchPda,
            vault,
            playerToken: playerAtas[i]!,
          }),
        ],
        [player],
      );
    }
  }

  /**
   * The settle transaction, built exactly as `settler.ts` builds it.
   *
   * `tamperDigest` flips one byte of the signed digest AFTER signing, so the
   * signature is genuine but attests to something the program will not
   * recompute — which is what a doctored result looks like from the chain's
   * side. That is S6.
   */
  function settleIxs(args: {
    matchPda: PublicKey;
    vault: PublicKey;
    winner: PublicKey;
    winnerToken: PublicKey;
    scores: bigint[];
    tamperDigest?: boolean;
  }): TransactionInstruction[] {
    const digest = createHash("sha256")
      .update(
        settleMessagePreimage(args.matchPda, args.winner, args.scores),
      )
      .digest();
    const signature = nacl.sign.detached(digest, authority.secretKey);

    const attested = Uint8Array.from(digest);
    if (args.tamperDigest === true) {
      attested[0] = attested[0]! ^ 0xff;
      // Re-sign the tampered digest, so the precompile itself is satisfied and
      // the refusal has to come from the program's own recomputation. Signing
      // the original would only prove the precompile works.
      const resigned = nacl.sign.detached(attested, authority.secretKey);
      return [
        buildEd25519VerifyIx(
          authority.publicKey.toBytes(),
          resigned,
          attested,
        ),
        settleIx(args),
      ];
    }

    // Order is load-bearing: settle_match reads instruction 0 out of the
    // instructions sysvar and rejects anything that is not the ed25519 verify.
    return [
      buildEd25519VerifyIx(authority.publicKey.toBytes(), signature, digest),
      settleIx(args),
    ];
  }

  function settleIx(args: {
    matchPda: PublicKey;
    vault: PublicKey;
    winner: PublicKey;
    winnerToken: PublicKey;
    scores: bigint[];
  }): TransactionInstruction {
    return buildSettleMatchIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      matchPda: args.matchPda,
      vault: args.vault,
      winnerToken: args.winnerToken,
      // Still a required account at 0 bps, where settler.ts passes the winner's
      // own token account as the stand-in.
      treasuryToken: RAKE_BPS > 0 ? treasury : args.winnerToken,
      winner: args.winner,
      scores: args.scores,
    });
  }

  async function expectFailure(
    ixs: TransactionInstruction[],
    signers: Keypair[],
    what: string,
  ): Promise<void> {
    let threw = false;
    try {
      await send(ixs, signers);
    } catch {
      threw = true;
    }
    assert.isTrue(threw, what);
  }

  // -------------------------------------------------------------------- setup

  before(async () => {
    await assertProgramDeployed();

    const mintEnv = process.env.ARENA_STAKE_MINT;
    if (mintEnv === undefined || mintEnv === "") {
      throw new Error(
        "ARENA_STAKE_MINT is not set. Run scripts/devnet/setup.ts first.",
      );
    }
    mint = new PublicKey(mintEnv);
    decimals = await mintDecimals(mint);

    if (RAKE_BPS > 0) {
      const t = process.env.TREASURY_TOKEN_ACCOUNT;
      if (t === undefined || t === "") {
        throw new Error(
          `ARENA_RAKE_BPS is ${RAKE_BPS} but TREASURY_TOKEN_ACCOUNT is not set.`,
        );
      }
      treasury = new PublicKey(t);
    } else {
      treasury = deriveAta(funder.publicKey, mint);
    }

    // Tier 1. The tiers are whole tokens -- 1 / 5 / 25 -- and entry_fee is
    // derived server-side as tier * 10^decimals, never sent by a client.
    entryFee = whole(1n, decimals);

    console.log(`    rpc       ${RPC_URL}`);
    console.log(`    program   ${PROGRAM_ID.toBase58()}`);
    console.log(`    mint      ${mint.toBase58()} (${decimals} decimals)`);
    console.log(`    rake      ${RAKE_BPS} bps`);
    console.log(`    authority ${authority.publicKey.toBase58()} (throwaway)`);

    // The authority pays rent for every MatchAccount and vault ATA: ~0.0085 SOL
    // per match, returned by close_match. Seven scenarios plus headroom.
    await fundFromPayer(funder, authority.publicKey, 0.5);
    for (const p of players) {
      await fundFromPayer(funder, p.publicKey, 0.05);
    }

    // Each player needs enough for every scenario that stakes: 5 matches x 1
    // token, with room to spare. Running short surfaces as FeeMismatch, which
    // looks exactly like a bug in whatever is under test.
    playerAtas = players.map((p) => deriveAta(p.publicKey, mint));
    await send(
      [
        ...players.flatMap((p, i) => [
          createAssociatedTokenAccountInstruction(
            funder.publicKey,
            playerAtas[i]!,
            p.publicKey,
            mint,
          ),
          createMintToInstruction(
            mint,
            playerAtas[i]!,
            funder.publicKey,
            whole(20n, decimals),
          ),
        ]),
      ],
      [funder],
    );
  });

  // ----------------------------------------------------------------------- S1

  it("S1: a created match is Open, with the configured fee, rake and treasury", async () => {
    const { matchPda } = await openMatch();
    const m = await readMatch(matchPda);

    assert.equal(m.status, MatchStatus.Open);
    assert.equal(m.entryFee, entryFee, "entry fee");
    assert.equal(m.rakeBps, RAKE_BPS, "rake bps");
    assert.equal(m.maxPlayers, 2, "max players");
    assert.equal(m.playerCount, 0, "nobody has staked yet");
    assert.equal(m.mint.toBase58(), mint.toBase58(), "mint");
    assert.equal(m.authority.toBase58(), authority.publicKey.toBase58());
    if (RAKE_BPS > 0) {
      // Recorded at create_match precisely so settle_match can refuse any other
      // destination -- the digest names the winner, not where the rake goes.
      assert.equal(
        m.treasury.toBase58(),
        treasury.toBase58(),
        "treasury pinned on the match",
      );
    }
  });

  // ----------------------------------------------------------------------- S2

  it("S2: two stakes fill the match to InProgress with the pot in the vault", async () => {
    const { matchPda, vault } = await openMatch();
    await fill(matchPda, vault);

    const m = await readMatch(matchPda);
    assert.equal(
      m.status,
      MatchStatus.InProgress,
      "a full match must be InProgress -- settle_match accepts nothing else",
    );
    assert.equal(m.playerCount, 2);
    assert.equal(await tokenBalance(vault), entryFee * 2n, "vault holds the pot");

    // Join order is what settle_match's `scores` is indexed against, and what
    // the client derives standings from. Not any server-side ordering.
    assert.deepEqual(
      m.players.slice(0, m.playerCount).map((p) => p.toBase58()),
      players.map((p) => p.publicKey.toBase58()),
      "players[] is in join order",
    );
  });

  // -------------------------------------------------------------------- S3/S4

  it("S3+S4: settlement pays the winner, the rake is exact, and the vault empties", async () => {
    const { matchPda, vault } = await openMatch();
    await fill(matchPda, vault);

    const winner = players[0]!;
    const winnerToken = playerAtas[0]!;
    const before = await tokenBalance(winnerToken);
    const treasuryBefore = await tokenBalance(treasury);

    const pot = entryFee * 2n;
    // The program's own arithmetic, checked_mul/checked_div, integer division.
    const expectedRake = (pot * BigInt(RAKE_BPS)) / 10_000n;
    const expectedPayout = pot - expectedRake;

    await send(
      settleIxs({
        matchPda,
        vault,
        winner: winner.publicKey,
        winnerToken,
        scores: [100n, 50n],
      }),
      [authority],
    );

    const m = await readMatch(matchPda);
    assert.equal(m.status, MatchStatus.Settled, "status");
    assert.equal(await tokenBalance(vault), 0n, "vault must self-empty");
    assert.equal(
      (await tokenBalance(winnerToken)) - before,
      expectedPayout,
      "winner receives pot minus rake",
    );
    if (RAKE_BPS > 0) {
      assert.equal(
        (await tokenBalance(treasury)) - treasuryBefore,
        expectedRake,
        `rake must be exactly pot * ${RAKE_BPS} / 10000`,
      );
    }

    // close_match returns both rents. Without it every match this key created
    // would hold ~0.0085 SOL forever and stay in the sweeper's scan.
    const authorityBefore = await connection.getBalance(authority.publicKey);
    await send(
      [
        buildCloseMatchIx({
          programId: PROGRAM_ID,
          authority: authority.publicKey,
          matchPda,
          vault,
        }),
      ],
      [authority],
    );
    assert.isNull(
      await connection.getAccountInfo(matchPda),
      "match account deallocated",
    );
    assert.isNull(await connection.getAccountInfo(vault), "vault deallocated");
    assert.isAbove(
      await connection.getBalance(authority.publicKey),
      authorityBefore,
      "rent returned to the authority",
    );
  });

  // ----------------------------------------------------------------------- S5

  it("S5: an unfilled lobby refunds every staker exactly their stake", async () => {
    const { matchPda, vault } = await openMatch();

    // One player stakes; the lobby never fills. This is the state an abandoned
    // wagered lobby is left in, and the reason settle_match cannot help: it
    // only accepts InProgress, so an unfilled match can never be paid out.
    await send(
      [
        buildJoinMatchIx({
          programId: PROGRAM_ID,
          player: players[0]!.publicKey,
          matchPda,
          vault,
          playerToken: playerAtas[0]!,
        }),
      ],
      [players[0]!],
    );

    const before = await tokenBalance(playerAtas[0]!);
    assert.equal(await tokenBalance(vault), entryFee);

    await send(
      [
        buildCancelMatchIx({
          programId: PROGRAM_ID,
          authority: authority.publicKey,
          matchPda,
          vault,
          // Paired positionally to players[], which cancel_match verifies:
          // each refund account must be owned by players[i] and hold the
          // match's mint.
          refundTokenAccounts: [playerAtas[0]!],
        }),
      ],
      [authority],
    );

    const m = await readMatch(matchPda);
    assert.equal(m.status, MatchStatus.Cancelled);
    assert.equal(await tokenBalance(vault), 0n, "vault drained");
    assert.equal(
      (await tokenBalance(playerAtas[0]!)) - before,
      entryFee,
      "refunded exactly the stake",
    );
  });

  it("S5b: a refund account that is not the staker's is refused", async () => {
    const { matchPda, vault } = await openMatch();
    await send(
      [
        buildJoinMatchIx({
          programId: PROGRAM_ID,
          player: players[0]!.publicKey,
          matchPda,
          vault,
          playerToken: playerAtas[0]!,
        }),
      ],
      [players[0]!],
    );

    // players[1]'s account in players[0]'s slot. Before this check existed,
    // remaining_accounts[i] went straight into token::transfer with nothing
    // tying it to players[i].
    await expectFailure(
      [
        buildCancelMatchIx({
          programId: PROGRAM_ID,
          authority: authority.publicKey,
          matchPda,
          vault,
          refundTokenAccounts: [playerAtas[1]!],
        }),
      ],
      [authority],
      "cancel_match must reject a refund account not owned by players[0]",
    );
    assert.equal(
      await tokenBalance(vault),
      entryFee,
      "the stake stays in the vault",
    );
  });

  // ----------------------------------------------------------------------- S6

  it("S6: a signature over a different digest is rejected and the pot is untouched", async () => {
    const { matchPda, vault } = await openMatch();
    await fill(matchPda, vault);

    const winnerToken = playerAtas[0]!;
    const before = await tokenBalance(winnerToken);

    await expectFailure(
      settleIxs({
        matchPda,
        vault,
        winner: players[0]!.publicKey,
        winnerToken,
        scores: [100n, 50n],
        tamperDigest: true,
      }),
      [authority],
      "settle_match must reject a digest it does not recompute",
    );

    const m = await readMatch(matchPda);
    assert.equal(m.status, MatchStatus.InProgress, "status unchanged");
    assert.equal(await tokenBalance(vault), entryFee * 2n, "pot untouched");
    assert.equal(await tokenBalance(winnerToken), before, "nobody paid");
  });

  it("S6b: a settle that redirects the rake to another account is refused", async function () {
    if (RAKE_BPS === 0) {
      this.skip();
      return;
    }
    const { matchPda, vault } = await openMatch();
    await fill(matchPda, vault);

    // A treasury the authority controls, but not the one recorded on the match.
    const other = deriveAta(authority.publicKey, mint);
    const digest = createHash("sha256")
      .update(
        settleMessagePreimage(matchPda, players[0]!.publicKey, [100n, 50n]),
      )
      .digest();
    const signature = nacl.sign.detached(digest, authority.secretKey);

    // The account must exist and hold the right mint, so the refusal can only
    // come from the address pin rather than from a missing or mismatched
    // account. Idempotent, so a re-run is fine.
    await send(
      [
        buildCreateAtaIdempotentIx(
          authority.publicKey,
          authority.publicKey,
          mint,
        ),
      ],
      [authority],
    );

    await expectFailure(
      [
        buildEd25519VerifyIx(authority.publicKey.toBytes(), signature, digest),
        buildSettleMatchIx({
          programId: PROGRAM_ID,
          authority: authority.publicKey,
          matchPda,
          vault,
          winnerToken: playerAtas[0]!,
          treasuryToken: other,
          winner: players[0]!.publicKey,
          scores: [100n, 50n],
        }),
      ],
      [authority],
      "settle_match must pin the treasury to the one recorded at create_match",
    );
    assert.equal(await tokenBalance(vault), entryFee * 2n, "pot untouched");
  });

  // ----------------------------------------------------------------------- S7

  it("S7: a winner with no canonical ATA is paid after ensureTokenAccount creates it", async () => {
    // The real shape of this case: join_match checks only `owner` and `mint`,
    // NOT canonical ATA derivation, so a player can legitimately stake from a
    // plain token account and never have an ATA at all. settle_match will not
    // create one -- it checks winner_token.owner == winner and stops -- so the
    // payout would fail with the pot already in the vault.
    const newbie = Keypair.generate();
    await fundFromPayer(funder, newbie.publicKey, 0.05);

    // A non-ATA token account: created as a plain account, not derived.
    const oddAccount = Keypair.generate();
    const tokenRent =
      await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: funder.publicKey,
          newAccountPubkey: oddAccount.publicKey,
          space: TOKEN_ACCOUNT_SIZE,
          lamports: tokenRent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeAccount3Instruction(
          oddAccount.publicKey,
          mint,
          newbie.publicKey,
        ),
        createMintToInstruction(
          mint,
          oddAccount.publicKey,
          funder.publicKey,
          whole(5n, decimals),
        ),
      ],
      [funder, oddAccount],
    );

    const newbieAta = deriveAta(newbie.publicKey, mint);
    assert.isNull(
      await connection.getAccountInfo(newbieAta),
      "precondition: the winner has no canonical ATA",
    );

    const { matchPda, vault } = await openMatch();
    await send(
      [
        buildJoinMatchIx({
          programId: PROGRAM_ID,
          player: players[0]!.publicKey,
          matchPda,
          vault,
          playerToken: playerAtas[0]!,
        }),
      ],
      [players[0]!],
    );
    await send(
      [
        buildJoinMatchIx({
          programId: PROGRAM_ID,
          player: newbie.publicKey,
          matchPda,
          vault,
          playerToken: oddAccount.publicKey,
        }),
      ],
      [newbie],
    );
    assert.equal(
      (await readMatch(matchPda)).status,
      MatchStatus.InProgress,
      "the odd account staked fine -- join_match checks owner and mint only",
    );

    // In its OWN transaction, exactly as settler.ts does it, so it cannot push
    // the settle tx over the size limit or disturb ed25519-at-index-0.
    await send(
      [
        buildCreateAtaIdempotentIx(
          authority.publicKey,
          newbie.publicKey,
          mint,
        ),
      ],
      [authority],
    );
    assert.isNotNull(
      await connection.getAccountInfo(newbieAta),
      "ensureTokenAccount created the ATA",
    );

    await send(
      settleIxs({
        matchPda,
        vault,
        winner: newbie.publicKey,
        winnerToken: newbieAta,
        scores: [50n, 100n],
      }),
      [authority],
    );

    const pot = entryFee * 2n;
    const expectedPayout = pot - (pot * BigInt(RAKE_BPS)) / 10_000n;
    assert.equal(
      await tokenBalance(newbieAta),
      expectedPayout,
      "winner paid into the account created for them",
    );
    assert.equal((await readMatch(matchPda)).status, MatchStatus.Settled);
  });

  after(() => {
    console.log(
      `\n    The throwaway authority ${authority.publicKey.toBase58()} keeps any\n` +
        `    leftover devnet SOL. It is not reused; nothing needs recovering.`,
    );
  });
});
