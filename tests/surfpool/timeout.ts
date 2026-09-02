/**
 * The one thing bankrun cannot prove: MATCH_TIMEOUT_SECS against a really
 * deployed program.
 *
 * bankrun runs an in-process SVM and loads arena.so directly, which is why the
 * other 42 tests are fast and hermetic — but it is not a deploy. This exercises
 * the timeout branch of `cancel_match`, and then `close_match`, against a
 * program that went through `solana program deploy` on a real validator, using
 * the same `arenaProgram.ts` bindings the server ships. Surfpool's
 * `surfnet_timeTravel` cheatcode is what makes a 24-hour deadline testable at
 * all; on a plain `solana-test-validator` you would have to wait.
 *
 * Deliberately NOT part of `npm test` — it needs a validator listening. The
 * default mocha glob is `tests/*.ts`, so this directory is skipped and run on
 * its own. See docs/surfpool.md for the three commands.
 */
import { assert } from "chai";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  MATCH_TIMEOUT_SECS,
  MatchStatus,
  buildCancelMatchIx,
  buildCloseMatchIx,
  buildCreateMatchIx,
  buildJoinMatchIx,
  decodeMatchAccount,
  deriveAta,
} from "../../OpenFrontIO/src/core/arena/arenaProgram";

const RPC_URL = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(
  process.env.ARENA_PROGRAM_ID ??
    "4CGRLB5WJ4LK4nqwhzN5uhU78cakuHzG5wfrUZrQ2G64",
);

const ENTRY_FEE = 1_000n;
const RAKE_BPS = 0;

describe("surfpool: cancel_match timeout against a deployed program", function () {
  this.timeout(180_000);

  const connection = new Connection(RPC_URL, "confirmed");
  const authority = Keypair.generate();
  const players = [Keypair.generate(), Keypair.generate()];

  let mint: PublicKey;
  let playerAtas: PublicKey[];
  let matchPda: PublicKey;
  let vault: PublicKey;
  let createdAt: bigint;

  async function send(
    ixs: TransactionInstruction[],
    signers: Signer[],
  ): Promise<string> {
    const tx = new Transaction().add(...ixs);
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0]!.publicKey;
    tx.sign(...signers);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  async function fund(pubkey: PublicKey, sol = 5): Promise<void> {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  async function tokenBalance(account: PublicKey): Promise<bigint> {
    const info = await connection.getAccountInfo(account);
    if (info === null) return 0n;
    return Buffer.from(info.data).readBigUInt64LE(64);
  }

  async function readMatch(pda: PublicKey) {
    const info = await connection.getAccountInfo(pda);
    assert.isNotNull(info, `match account ${pda.toBase58()} not found`);
    return decodeMatchAccount(info!.data, info!.owner, PROGRAM_ID);
  }

  /**
   * surfnet_timeTravel — the whole reason this suite uses Surfpool.
   *
   * `absoluteTimestamp` is in MILLISECONDS, despite the cheatcode docs calling
   * it a UNIX timestamp and despite the on-chain clock this moves
   * (`Clock::unix_timestamp`, and so `MatchAccount.created_at`) being in
   * seconds. Pass seconds and it refuses with "Cannot travel to past
   * timestamp", because it compares against a millisecond `now`. Hence the
   * conversion here rather than at the call site.
   */
  async function timeTravelToSeconds(unixSeconds: number): Promise<void> {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_timeTravel",
        params: [{ absoluteTimestamp: unixSeconds * 1000 }],
      }),
    });
    const body = (await res.json()) as { error?: { message: string } };
    if (body.error) {
      throw new Error(
        `surfnet_timeTravel failed: ${body.error.message}. Is this Surfpool ` +
          `rather than solana-test-validator? The cheatcode exists nowhere else.`,
      );
    }
  }

  function cancelIx(): TransactionInstruction {
    return buildCancelMatchIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      matchPda,
      vault,
      refundTokenAccounts: playerAtas,
    });
  }

  before(async () => {
    const programInfo = await connection.getAccountInfo(PROGRAM_ID);
    assert.isTrue(
      programInfo?.executable === true,
      `${PROGRAM_ID.toBase58()} is not an executable account on ${RPC_URL}. ` +
        `Start Surfpool and deploy the program first — see docs/surfpool.md.`,
    );

    await fund(authority.publicKey);
    for (const p of players) await fund(p.publicKey);

    const mintKp = Keypair.generate();
    mint = mintKp.publicKey;
    playerAtas = players.map((p) => deriveAta(p.publicKey, mint));
    const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: authority.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports: rent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 0, authority.publicKey, null),
        ...players.flatMap((p, i) => [
          createAssociatedTokenAccountInstruction(
            authority.publicKey,
            playerAtas[i]!,
            p.publicKey,
            mint,
          ),
          createMintToInstruction(
            mint,
            playerAtas[i]!,
            authority.publicKey,
            Number(ENTRY_FEE) * 2,
          ),
        ]),
      ],
      [authority, mintKp],
    );

    // A nonce nothing else will reuse. The PDA is seeded on it, so a repeat run
    // against a surfnet that was not reset would otherwise collide on `init`.
    const nonce = BigInt(Date.now()) & 0xffffffffffffn;
    const created = buildCreateMatchIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      mint,
      entryFee: ENTRY_FEE,
      maxPlayers: 2,
      rakeBps: RAKE_BPS,
      nonce,
    });
    matchPda = created.matchPda;
    vault = created.vault;
    await send([created.ix], [authority]);

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

    const filled = await readMatch(matchPda);
    assert.equal(
      filled.status,
      MatchStatus.InProgress,
      "a full match should be InProgress",
    );
    assert.equal(await tokenBalance(vault), ENTRY_FEE * 2n);
    createdAt = filled.createdAt;
  });

  it("refuses a cancel before the deadline", async () => {
    // The check that stops the authority cancelling a live match mid-play.
    let threw = false;
    try {
      await send([cancelIx()], [authority]);
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "an InProgress match must not be cancellable yet");
    assert.equal(
      (await readMatch(matchPda)).status,
      MatchStatus.InProgress,
      "the match should be untouched",
    );
  });

  it("refunds every staker once the deadline has passed", async () => {
    // created_at is read from chain rather than assumed: the surfnet's clock
    // does not necessarily start at wall-clock now.
    await timeTravelToSeconds(Number(createdAt) + MATCH_TIMEOUT_SECS + 60);

    await send([cancelIx()], [authority]);

    assert.equal((await readMatch(matchPda)).status, MatchStatus.Cancelled);
    assert.equal(await tokenBalance(vault), 0n, "vault should be drained");
    for (const ata of playerAtas) {
      assert.equal(
        await tokenBalance(ata),
        ENTRY_FEE * 2n,
        "every staker should be made whole",
      );
    }
  });

  it("close_match returns both rents to the authority", async () => {
    const before = (await connection.getAccountInfo(authority.publicKey))!
      .lamports;

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
      "close_match should deallocate the match account",
    );
    assert.isNull(
      await connection.getAccountInfo(vault),
      "close_match should close the vault too, not just the match",
    );
    const after = (await connection.getAccountInfo(authority.publicKey))!
      .lamports;
    assert.isAbove(after, before, "both rents should return to the authority");
  });
});
