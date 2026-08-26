// Proves the hand-rolled bindings in OpenFrontIO/src/core/arena/arenaProgram.ts.
//
// The game server does not use @coral-xyz/anchor — it builds arena instructions
// byte by byte so the browser half of the wager flow stays small. That trades a
// generated coder for constants that can silently drift from the program. This
// suite closes that gap from both ends:
//
//   1. every constant is diffed against the generated target/idl/arena.json, so
//      a program change that moves a discriminator or a field fails here;
//   2. the create_match and join_match instructions that would actually be sent
//      are executed against the real program in bankrun and the resulting
//      account is read back through decodeMatchAccount — the same decoder the
//      server uses — so the bytes are proven, not just typed.
//
// (1) alone would pass on an IDL that is itself stale; (2) alone would pass on
// a layout that happens to round-trip. Together they pin both.

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { startAnchor } from "anchor-bankrun";
import { ProgramTestContext } from "solana-bankrun";
import { assert } from "chai";
import { createHash } from "crypto";
import nacl from "tweetnacl";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID as ARENA_ATA_PROGRAM_ID,
  IX_DISCRIMINATOR,
  MATCH_ACCOUNT_DISCRIMINATOR,
  MATCH_ACCOUNT_LAYOUT,
  MATCH_ACCOUNT_SIZE,
  MATCH_TIMEOUT_SECS,
  MAX_PLAYERS,
  MAX_RAKE_BPS,
  MatchStatus,
  TOKEN_PROGRAM_ID as ARENA_TOKEN_PROGRAM_ID,
  buildCancelMatchIx,
  buildCreateAtaIdempotentIx,
  buildCreateMatchIx,
  buildEd25519VerifyIx,
  buildJoinMatchIx,
  buildSettleMatchIx,
  decodeMatchAccount,
  deriveAta,
  deriveMatchPda,
  deriveVaultAta,
  settleMessagePreimage,
} from "../OpenFrontIO/src/core/arena/arenaProgram";

import idlJson from "../target/idl/arena.json";

interface IdlField {
  name: string;
  type: IdlType;
}
type IdlType =
  | string
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { defined: { name: string } };
interface ArenaIdl {
  address: string;
  instructions: {
    name: string;
    discriminator: number[];
    accounts: { name: string; writable?: boolean; signer?: boolean }[];
    args: IdlField[];
  }[];
  accounts: { name: string; discriminator: number[] }[];
  constants: { name: string; type: string; value: string }[];
  types: {
    name: string;
    type:
      | { kind: "struct"; fields: IdlField[] }
      | { kind: "enum"; variants: { name: string }[] };
  }[];
}

// The JSON import gives TS a wide structural literal type; ArenaIdl is the
// shape this suite actually reads out of it.
const idl = idlJson as unknown as ArenaIdl;

/**
 * Byte width of an IDL type. Anchor's Borsh packs with no alignment padding, so
 * a field's offset is just the sum of the widths preceding it.
 */
function sizeOf(t: IdlType, idlTypes: ArenaIdl["types"]): number {
  if (typeof t === "string") {
    switch (t) {
      case "u8":
      case "i8":
      case "bool":
        return 1;
      case "u16":
      case "i16":
        return 2;
      case "u32":
      case "i32":
        return 4;
      case "u64":
      case "i64":
        return 8;
      case "pubkey":
        return 32;
      default:
        throw new Error(`unhandled IDL scalar: ${t}`);
    }
  }
  if ("array" in t) return sizeOf(t.array[0], idlTypes) * t.array[1];
  if ("defined" in t) {
    const def = idlTypes.find((x) => x.name === t.defined.name);
    if (!def) throw new Error(`unknown defined type ${t.defined.name}`);
    if (def.type.kind !== "enum") {
      throw new Error(`${t.defined.name} is not a fieldless enum`);
    }
    return 1; // Borsh writes a C-like enum as a single discriminant byte.
  }
  throw new Error(`unhandled IDL type: ${JSON.stringify(t)}`);
}

describe("arenaProgram bindings", () => {
  describe("diffed against target/idl/arena.json", () => {
    it("instruction discriminators match the IDL", () => {
      for (const [name, expected] of Object.entries(IX_DISCRIMINATOR)) {
        const fromIdl = idl.instructions.find((i) => i.name === name);
        assert.isDefined(fromIdl, `IDL has no instruction named "${name}"`);
        assert.deepEqual(
          Array.from(expected),
          fromIdl!.discriminator,
          `discriminator drift on ${name}`,
        );
      }
      // ...and nothing in the IDL is missing from our table.
      assert.deepEqual(
        idl.instructions.map((i) => i.name).sort(),
        Object.keys(IX_DISCRIMINATOR).sort(),
      );
    });

    it("discriminators are the snake_case hash, not the camelCase one", () => {
      // Anchor 0.30 named instructions in camelCase in the IDL; 0.31 uses
      // snake_case. Hashing the wrong spelling yields eight different bytes the
      // program rejects, and the failure surfaces only on-chain. Pin the rule.
      const hash8 = (s: string) =>
        Array.from(createHash("sha256").update(s).digest().subarray(0, 8));
      assert.deepEqual(
        Array.from(IX_DISCRIMINATOR.create_match),
        hash8("global:create_match"),
      );
      assert.notDeepEqual(
        Array.from(IX_DISCRIMINATOR.create_match),
        hash8("global:createMatch"),
      );
    });

    it("MatchAccount discriminator matches the IDL", () => {
      const fromIdl = idl.accounts.find((a) => a.name === "MatchAccount");
      assert.isDefined(fromIdl);
      assert.deepEqual(
        Array.from(MATCH_ACCOUNT_DISCRIMINATOR),
        fromIdl!.discriminator,
      );
    });

    it("MatchAccount field offsets and size match the IDL", () => {
      const def = idl.types.find((t) => t.name === "MatchAccount");
      assert.isDefined(def);
      if (def!.type.kind !== "struct") throw new Error("expected a struct");

      // snake_case in the IDL, camelCase in the layout table.
      const camel = (s: string) =>
        s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

      let offset = 8; // account discriminator
      const expected: Record<string, number> = { discriminator: 0 };
      for (const field of def!.type.fields) {
        expected[camel(field.name)] = offset;
        offset += sizeOf(field.type, idl.types);
      }

      assert.deepEqual(
        MATCH_ACCOUNT_LAYOUT as unknown as Record<string, number>,
        expected,
      );
      assert.equal(MATCH_ACCOUNT_SIZE, offset);
    });

    it("create_match account order and arg order match the IDL", () => {
      const ix = idl.instructions.find((i) => i.name === "create_match")!;
      assert.deepEqual(
        ix.accounts.map((a) => a.name),
        [
          "authority",
          "match_account",
          "vault",
          "mint",
          "token_program",
          "associated_token_program",
          "system_program",
          "rent",
        ],
      );
      assert.deepEqual(
        ix.args.map((a) => a.name),
        ["entry_fee", "max_players", "rake_bps", "nonce"],
      );
    });

    it("join_match account order matches the IDL and it takes no args", () => {
      const ix = idl.instructions.find((i) => i.name === "join_match")!;
      assert.deepEqual(
        ix.accounts.map((a) => a.name),
        ["player", "match_account", "vault", "player_token", "token_program"],
      );
      // No amount arg on purpose: the program transfers match_account.entry_fee
      // read from chain state, so a client cannot understake by lying.
      assert.deepEqual(ix.args, []);
    });

    it("settle_match account order and arg order match the IDL", () => {
      const ix = idl.instructions.find((i) => i.name === "settle_match")!;
      assert.deepEqual(
        ix.accounts.map((a) => a.name),
        [
          "match_account",
          "vault",
          "winner_token",
          "treasury_token",
          "sysvar_instructions",
          "token_program",
        ],
      );
      assert.deepEqual(
        ix.args.map((a) => a.name),
        ["winner", "scores"],
      );
      // No Signer account: the server authorises through the ed25519 prelude
      // instruction, not by signing this one.
      assert.isUndefined(ix.accounts.find((a) => a.signer === true));
    });

    it("cancel_match account order matches the IDL", () => {
      const ix = idl.instructions.find((i) => i.name === "cancel_match")!;
      assert.deepEqual(
        ix.accounts.map((a) => a.name),
        ["authority", "match_account", "vault", "token_program"],
      );
      assert.deepEqual(ix.args, []);
      assert.isTrue(ix.accounts[0].signer, "authority must sign a cancel");
    });

    it("MatchStatus discriminants follow the IDL variant order", () => {
      const def = idl.types.find((t) => t.name === "MatchStatus")!;
      if (def.type.kind !== "enum") throw new Error("expected an enum");
      assert.deepEqual(
        def.type.variants.map((v) => v.name),
        ["Open", "InProgress", "Settled", "Cancelled"],
      );
      assert.equal(MatchStatus.Open, 0);
      assert.equal(MatchStatus.Cancelled, 3);
    });

    it("program constants agree with the Rust source", () => {
      assert.equal(MAX_PLAYERS, 16);
      assert.equal(MAX_RAKE_BPS, 1000);
      assert.equal(ARENA_TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    });

    it("MATCH_TIMEOUT_SECS is diffed against the IDL, not hand-copied", () => {
      // The only arena constant the IDL actually carries (it is #[constant] in
      // Rust). MAX_PLAYERS and MAX_RAKE_BPS above are literal assertions, but
      // both are pinned indirectly -- MAX_PLAYERS by MATCH_ACCOUNT_SIZE and the
      // field offsets, MAX_RAKE_BPS by create_match's own rejection. The
      // timeout has no such second anchor, so it needs this one.
      const fromIdl = idl.constants.find((c) => c.name === "MATCH_TIMEOUT_SECS");
      assert.isDefined(fromIdl, "MATCH_TIMEOUT_SECS missing from the IDL");
      assert.equal(fromIdl!.type, "i64");
      assert.equal(
        Number(fromIdl!.value),
        MATCH_TIMEOUT_SECS,
        "arenaProgram.ts MATCH_TIMEOUT_SECS has drifted from the program",
      );
    });
  });

  describe("executed against the program in bankrun", () => {
    let context: ProgramTestContext;
    const programId = new PublicKey(idl.address);
    const authority = Keypair.generate();
    const mintKp = Keypair.generate();

    const ENTRY_FEE = 250_000n;
    const MAX_PLAYERS_CFG = 6;
    const RAKE_BPS = 250;
    // Deliberately large: exercises the full u64 width of the nonce seed, which
    // is where a wrong endianness or a JS number would quietly diverge.
    const NONCE = 0xfedcba9876543210n;

    before(async () => {
      context = await startAnchor(".", [], [
        {
          address: authority.publicKey,
          info: {
            lamports: 10_000_000_000,
            data: Buffer.alloc(0),
            owner: SystemProgram.programId,
            executable: false,
          },
        },
      ]);

      const rent = await context.banksClient.getRent();
      await sendTx(
        [
          SystemProgram.createAccount({
            fromPubkey: authority.publicKey,
            newAccountPubkey: mintKp.publicKey,
            space: MINT_SIZE,
            lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeMint2Instruction(
            mintKp.publicKey,
            0,
            authority.publicKey,
            null,
          ),
        ],
        [authority, mintKp],
      );
    });

    async function sendTx(ixs: TransactionInstruction[], signers: Keypair[]) {
      const tx = new Transaction();
      tx.recentBlockhash = context.lastBlockhash;
      tx.feePayer = signers[0].publicKey;
      tx.add(...ixs);
      tx.sign(...signers);
      await context.banksClient.processTransaction(tx);
    }

    it("create_match built by arenaProgram.ts is accepted on-chain", async () => {
      const { ix, matchPda, vault } = buildCreateMatchIx({
        programId,
        authority: authority.publicKey,
        mint: mintKp.publicKey,
        entryFee: ENTRY_FEE,
        maxPlayers: MAX_PLAYERS_CFG,
        rakeBps: RAKE_BPS,
        nonce: NONCE,
      });

      // 8-byte discriminator + u64 + u8 + u16 + u64.
      assert.equal(ix.data.length, 27, "unexpected instruction data length");
      assert.deepEqual(
        Array.from(ix.data.subarray(0, 8)),
        Array.from(IX_DISCRIMINATOR.create_match),
      );

      // A wrong PDA derivation fails the program's seeds constraint, so this
      // succeeding is what proves deriveMatchPda/deriveVaultAta.
      await sendTx([ix], [authority]);

      const raw = await context.banksClient.getAccount(matchPda);
      assert.isNotNull(raw, "match_account was not created");
      const data = Buffer.from(raw!.data);

      assert.equal(
        raw!.owner.toString(),
        programId.toBase58(),
        "match_account is not owned by the arena program",
      );
      assert.equal(data.length, MATCH_ACCOUNT_SIZE, "account size drift");
      assert.deepEqual(
        Array.from(data.subarray(0, 8)),
        Array.from(MATCH_ACCOUNT_DISCRIMINATOR),
      );

      const L = MATCH_ACCOUNT_LAYOUT;
      const pubkeyAt = (off: number) =>
        new PublicKey(data.subarray(off, off + 32)).toBase58();

      assert.equal(pubkeyAt(L.authority), authority.publicKey.toBase58());
      assert.equal(pubkeyAt(L.mint), mintKp.publicKey.toBase58());
      assert.equal(pubkeyAt(L.vault), vault.toBase58());
      assert.equal(data.readBigUInt64LE(L.entryFee), ENTRY_FEE);
      assert.equal(data.readUInt16LE(L.rakeBps), RAKE_BPS);
      assert.equal(data.readUInt8(L.maxPlayers), MAX_PLAYERS_CFG);
      assert.equal(data.readUInt8(L.playerCount), 0);
      assert.equal(data.readUInt8(L.status), MatchStatus.Open);
      assert.equal(data.readBigUInt64LE(L.nonce), NONCE);

      // The program wrote the bump it derived; ours must agree.
      const [, expectedBump] = deriveMatchPda(
        programId,
        authority.publicKey,
        NONCE,
      );
      assert.equal(data.readUInt8(L.bump), expectedBump);

      // players[] is zeroed until someone joins; stakes[] likewise.
      assert.isTrue(
        data.subarray(L.players, L.stakes).every((b) => b === 0),
        "players[] should be zeroed on a fresh match",
      );
      assert.isTrue(
        data.subarray(L.stakes, L.createdAt).every((b) => b === 0),
        "stakes[] should be zeroed on a fresh match",
      );
      assert.isAbove(
        Number(data.readBigInt64LE(L.createdAt)),
        0,
        "created_at should be set from the clock",
      );
    });

    it("the vault is a real ATA owned by the match PDA", async () => {
      const [matchPda] = deriveMatchPda(programId, authority.publicKey, NONCE);
      const vault = deriveVaultAta(matchPda, mintKp.publicKey);

      const raw = await context.banksClient.getAccount(vault);
      assert.isNotNull(raw, "vault ATA was not created");
      assert.equal(raw!.owner.toString(), TOKEN_PROGRAM_ID.toBase58());

      // SPL token account layout: mint(32) owner(32) amount(8).
      const data = Buffer.from(raw!.data);
      assert.equal(
        new PublicKey(data.subarray(0, 32)).toBase58(),
        mintKp.publicKey.toBase58(),
      );
      assert.equal(
        new PublicKey(data.subarray(32, 64)).toBase58(),
        matchPda.toBase58(),
        "vault authority must be the match PDA, not the server",
      );
      assert.equal(data.readBigUInt64LE(64), 0n);
      assert.equal(ARENA_ATA_PROGRAM_ID.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    });

    it("join_match built by arenaProgram.ts stakes the player on-chain", async () => {
      const [matchPda] = deriveMatchPda(programId, authority.publicKey, NONCE);
      const vault = deriveVaultAta(matchPda, mintKp.publicKey);

      // A funded player with an ATA holding exactly the entry fee. The surplus
      // check is the program's (FeeMismatch); an exact balance proves the
      // transfer amount comes from the account, not from anything we passed.
      const player = Keypair.generate();
      context.setAccount(player.publicKey, {
        lamports: 10_000_000_000,
        data: Buffer.alloc(0),
        owner: SystemProgram.programId,
        executable: false,
      });
      const playerToken = deriveAta(player.publicKey, mintKp.publicKey);
      await sendTx(
        [
          createAssociatedTokenAccountInstruction(
            player.publicKey,
            playerToken,
            player.publicKey,
            mintKp.publicKey,
          ),
          createMintToInstruction(
            mintKp.publicKey,
            playerToken,
            authority.publicKey,
            ENTRY_FEE,
          ),
        ],
        [player, authority],
      );

      const ix = buildJoinMatchIx({
        programId,
        player: player.publicKey,
        matchPda,
        vault,
        playerToken,
      });
      // Bare discriminator — join_match declares no args.
      assert.equal(ix.data.length, 8, "join_match should carry no args");
      assert.deepEqual(
        Array.from(ix.data),
        Array.from(IX_DISCRIMINATOR.join_match),
      );

      await sendTx([ix], [player]);

      const raw = await context.banksClient.getAccount(matchPda);
      const data = Buffer.from(raw!.data);
      const L = MATCH_ACCOUNT_LAYOUT;

      assert.equal(data.readUInt8(L.playerCount), 1);
      assert.equal(
        new PublicKey(data.subarray(L.players, L.players + 32)).toBase58(),
        player.publicKey.toBase58(),
        "players[0] should be the joining wallet",
      );
      assert.equal(data.readBigUInt64LE(L.stakes), ENTRY_FEE);
      // 6 max players, 1 joined: still Open.
      assert.equal(data.readUInt8(L.status), MatchStatus.Open);

      // The stake left the player and landed in the PDA-owned vault.
      const vaultRaw = await context.banksClient.getAccount(vault);
      assert.equal(Buffer.from(vaultRaw!.data).readBigUInt64LE(64), ENTRY_FEE);
      const playerRaw = await context.banksClient.getAccount(playerToken);
      assert.equal(Buffer.from(playerRaw!.data).readBigUInt64LE(64), 0n);
    });

    it("decodeMatchAccount reads back what the program wrote", async () => {
      const [matchPda, expectedBump] = deriveMatchPda(
        programId,
        authority.publicKey,
        NONCE,
      );
      const raw = await context.banksClient.getAccount(matchPda);
      const match = decodeMatchAccount(
        Uint8Array.from(raw!.data),
        new PublicKey(raw!.owner),
        programId,
      );

      assert.equal(match.authority.toBase58(), authority.publicKey.toBase58());
      assert.equal(match.mint.toBase58(), mintKp.publicKey.toBase58());
      assert.equal(
        match.vault.toBase58(),
        deriveVaultAta(matchPda, mintKp.publicKey).toBase58(),
      );
      assert.equal(match.entryFee, ENTRY_FEE);
      assert.equal(match.rakeBps, RAKE_BPS);
      assert.equal(match.maxPlayers, MAX_PLAYERS_CFG);
      assert.equal(match.nonce, NONCE);
      assert.equal(match.bump, expectedBump);
      assert.equal(match.status, MatchStatus.Open);
      assert.isAbove(Number(match.createdAt), 0);

      // players[]/stakes[] are trimmed to player_count — the preceding test
      // joined exactly one player, so the 15 unused slots must not appear.
      assert.equal(match.playerCount, 1);
      assert.lengthOf(match.players, 1);
      assert.lengthOf(match.stakes, 1);
      assert.equal(match.stakes[0], ENTRY_FEE);
      assert.notEqual(
        match.players[0].toBase58(),
        PublicKey.default.toBase58(),
        "players[0] should be a real wallet, not a zeroed slot",
      );
    });

    it("decodeMatchAccount refuses accounts it should not trust", async () => {
      const [matchPda] = deriveMatchPda(programId, authority.publicKey, NONCE);
      const raw = await context.banksClient.getAccount(matchPda);
      const data = Uint8Array.from(raw!.data);

      // Wrong owner: without this check any account of the right length would
      // decode into a plausible match, letting a caller be pointed at bytes an
      // attacker controls and read whatever players[] they wrote there.
      assert.throws(
        () => decodeMatchAccount(data, SystemProgram.programId, programId),
        /owned by/,
      );

      const wrongDiscriminator = Uint8Array.from(data);
      wrongDiscriminator[0] ^= 0xff;
      assert.throws(
        () => decodeMatchAccount(wrongDiscriminator, programId, programId),
        /discriminator/,
      );

      assert.throws(
        () => decodeMatchAccount(data.subarray(0, 100), programId, programId),
        /expected 774 bytes/,
      );

      // player_count past max_players would read unpopulated slots and invent
      // participants that never staked.
      const overcount = Uint8Array.from(data);
      overcount[MATCH_ACCOUNT_LAYOUT.playerCount] = MAX_PLAYERS_CFG + 1;
      assert.throws(
        () => decodeMatchAccount(overcount, programId, programId),
        /implausible player counts/,
      );

      const badStatus = Uint8Array.from(data);
      badStatus[MATCH_ACCOUNT_LAYOUT.status] = 9;
      assert.throws(
        () => decodeMatchAccount(badStatus, programId, programId),
        /unknown MatchStatus/,
      );
    });

    it("rejects out-of-range arguments before they reach the chain", () => {
      const base = {
        programId,
        authority: authority.publicKey,
        mint: mintKp.publicKey,
        entryFee: ENTRY_FEE,
        maxPlayers: MAX_PLAYERS_CFG,
        rakeBps: RAKE_BPS,
        nonce: NONCE,
      };
      assert.throws(
        () => buildCreateMatchIx({ ...base, maxPlayers: 17 }),
        /maxPlayers/,
      );
      assert.throws(
        () => buildCreateMatchIx({ ...base, maxPlayers: 1 }),
        /maxPlayers/,
      );
      assert.throws(
        () => buildCreateMatchIx({ ...base, rakeBps: 1001 }),
        /rakeBps/,
      );
      assert.throws(
        () => buildCreateMatchIx({ ...base, entryFee: -1n }),
        /u64 out of range/,
      );
    });
  });

  // Settlement is the point at which the pot actually moves, so the digest
  // format and the instruction layout are proven end to end here rather than
  // inferred. The failure this guards against is silent: a wrong preimage
  // produces a perfectly valid signature that the program rejects, and the pot
  // stays locked in the vault with no second chance to sign it correctly.
  describe("settlement, executed against the program in bankrun", () => {
    let context: ProgramTestContext;
    const programId = new PublicKey(idl.address);
    const authority = Keypair.generate();
    const mintKp = Keypair.generate();
    const treasuryOwner = Keypair.generate();

    const ENTRY_FEE = 1_000_000n;
    const RAKE_BPS = 250; // 2.5%
    const SETTLE_NONCE = 0x1122334455667788n;
    const CANCEL_NONCE = 0x99aabbccddeeff00n;

    let treasuryToken: PublicKey;

    async function sendTx(ixs: TransactionInstruction[], signers: Keypair[]) {
      const tx = new Transaction();
      tx.recentBlockhash = context.lastBlockhash;
      tx.feePayer = signers[0].publicKey;
      tx.add(...ixs);
      tx.sign(...signers);
      await context.banksClient.processTransaction(tx);
    }

    async function assertTxFails(
      ixs: TransactionInstruction[],
      signers: Keypair[],
    ) {
      let threw = false;
      try {
        await sendTx(ixs, signers);
      } catch {
        threw = true;
      }
      assert.isTrue(threw, "expected the program to reject this transaction");
    }

    before(async () => {
      context = await startAnchor(
        ".",
        [],
        [
          {
            address: authority.publicKey,
            info: {
              lamports: 100_000_000_000,
              data: Buffer.alloc(0),
              owner: SystemProgram.programId,
              executable: false,
            },
          },
        ],
      );

      const rent = await context.banksClient.getRent();
      await sendTx(
        [
          SystemProgram.createAccount({
            fromPubkey: authority.publicKey,
            newAccountPubkey: mintKp.publicKey,
            space: MINT_SIZE,
            lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeMint2Instruction(
            mintKp.publicKey,
            0,
            authority.publicKey,
            null,
          ),
        ],
        [authority, mintKp],
      );

      treasuryToken = deriveAta(treasuryOwner.publicKey, mintKp.publicKey);
      await sendTx(
        [
          buildCreateAtaIdempotentIx(
            authority.publicKey,
            treasuryOwner.publicKey,
            mintKp.publicKey,
          ),
        ],
        [authority],
      );
    });

    /** A funded wallet holding exactly one entry fee in its ATA. */
    async function fundedPlayer(): Promise<{ kp: Keypair; token: PublicKey }> {
      const kp = Keypair.generate();
      context.setAccount(kp.publicKey, {
        lamports: 10_000_000_000,
        data: Buffer.alloc(0),
        owner: SystemProgram.programId,
        executable: false,
      });
      const token = deriveAta(kp.publicKey, mintKp.publicKey);
      await sendTx(
        [
          buildCreateAtaIdempotentIx(
            kp.publicKey,
            kp.publicKey,
            mintKp.publicKey,
          ),
          createMintToInstruction(
            mintKp.publicKey,
            token,
            authority.publicKey,
            ENTRY_FEE,
          ),
        ],
        [kp, authority],
      );
      return { kp, token };
    }

    /** create_match plus enough joins to fill it, so status becomes InProgress. */
    async function filledMatch(nonce: bigint, seats: number) {
      const { ix, matchPda, vault } = buildCreateMatchIx({
        programId,
        authority: authority.publicKey,
        mint: mintKp.publicKey,
        entryFee: ENTRY_FEE,
        maxPlayers: seats,
        rakeBps: RAKE_BPS,
        nonce,
      });
      await sendTx([ix], [authority]);

      const players: { kp: Keypair; token: PublicKey }[] = [];
      for (let i = 0; i < seats; i++) {
        const player = await fundedPlayer();
        await sendTx(
          [
            buildJoinMatchIx({
              programId,
              player: player.kp.publicKey,
              matchPda,
              vault,
              playerToken: player.token,
            }),
          ],
          [player.kp],
        );
        players.push(player);
      }
      return { matchPda, vault, players };
    }

    async function readMatch(matchPda: PublicKey) {
      const raw = await context.banksClient.getAccount(matchPda);
      return decodeMatchAccount(
        Uint8Array.from(raw!.data),
        new PublicKey(raw!.owner),
        programId,
      );
    }

    async function tokenBalance(account: PublicKey): Promise<bigint> {
      const raw = await context.banksClient.getAccount(account);
      return Buffer.from(raw!.data).readBigUInt64LE(64);
    }

    /** Exactly what settler.ts signs: sha256 over settleMessagePreimage. */
    function settleDigest(
      matchPda: PublicKey,
      winner: PublicKey,
      scores: bigint[],
    ): Buffer {
      return createHash("sha256")
        .update(settleMessagePreimage(matchPda, winner, scores))
        .digest();
    }

    it("settle_match pays the winner and the treasury from a signed digest", async () => {
      const { matchPda, vault, players } = await filledMatch(SETTLE_NONCE, 2);

      const match = await readMatch(matchPda);
      assert.equal(
        match.status,
        MatchStatus.InProgress,
        "a full match should be InProgress before settlement",
      );

      // Positional against players[] in join order — the same vector
      // settler.ts rebuilds from chain state.
      const scores = [500n, 250n];
      const winner = match.players[0];
      const winnerToken = deriveAta(winner, mintKp.publicKey);

      const digest = settleDigest(matchPda, winner, scores);
      const signature = nacl.sign.detached(digest, authority.secretKey);

      const pot = await tokenBalance(vault);
      assert.equal(pot, ENTRY_FEE * 2n, "vault should hold both stakes");

      await sendTx(
        [
          // Index 0 is load-bearing: settle_match reads instruction 0 out of
          // the instructions sysvar and rejects anything that is not this.
          buildEd25519VerifyIx(
            authority.publicKey.toBytes(),
            signature,
            digest,
          ),
          buildSettleMatchIx({
            programId,
            matchPda,
            vault,
            winnerToken,
            treasuryToken,
            winner,
            scores,
          }),
        ],
        [authority],
      );

      const expectedRake = (pot * BigInt(RAKE_BPS)) / 10_000n;
      assert.equal(await tokenBalance(winnerToken), pot - expectedRake);
      assert.equal(await tokenBalance(treasuryToken), expectedRake);
      assert.equal(await tokenBalance(vault), 0n, "vault should be drained");
      assert.equal((await readMatch(matchPda)).status, MatchStatus.Settled);
      // The loser staked and got nothing back. That is the wager working.
      assert.equal(await tokenBalance(players[1].token), 0n);
    });

    it("the signed digest binds the scores, not just the winner", async () => {
      const { matchPda, vault } = await filledMatch(SETTLE_NONCE + 1n, 2);
      const winner = (await readMatch(matchPda)).players[0];

      // Sign one set of scores, submit another. The digest before Stage 5
      // hashed a JSON string of a server-side ordering, which would not have
      // bound these bytes at all: the standings recorded on-chain could differ
      // from the ones anybody actually signed.
      const digest = settleDigest(matchPda, winner, [500n, 250n]);
      const signature = nacl.sign.detached(digest, authority.secretKey);

      await assertTxFails(
        [
          buildEd25519VerifyIx(
            authority.publicKey.toBytes(),
            signature,
            digest,
          ),
          buildSettleMatchIx({
            programId,
            matchPda,
            vault,
            winnerToken: deriveAta(winner, mintKp.publicKey),
            treasuryToken,
            winner,
            scores: [250n, 500n],
          }),
        ],
        [authority],
      );
    });

    it("settle_match rejects a digest signed by anyone but the authority", async () => {
      const { matchPda, vault } = await filledMatch(SETTLE_NONCE + 2n, 2);
      const winner = (await readMatch(matchPda)).players[0];
      const scores = [1n, 2n];

      // A perfectly valid ed25519 signature over the correct digest. The
      // program still refuses it, because the key is not match.authority.
      const impostor = Keypair.generate();
      const digest = settleDigest(matchPda, winner, scores);
      const signature = nacl.sign.detached(digest, impostor.secretKey);

      await assertTxFails(
        [
          buildEd25519VerifyIx(impostor.publicKey.toBytes(), signature, digest),
          buildSettleMatchIx({
            programId,
            matchPda,
            vault,
            winnerToken: deriveAta(winner, mintKp.publicKey),
            treasuryToken,
            winner,
            scores,
          }),
        ],
        [authority],
      );
    });

    it("cancel_match refunds every staker in players[] order", async () => {
      // Three seats, two joins: the match never fills, so it stays Open and
      // settle_match would refuse it outright. This is the case settler.ts
      // resolves by refunding rather than leaving the pot locked.
      const { ix, matchPda, vault } = buildCreateMatchIx({
        programId,
        authority: authority.publicKey,
        mint: mintKp.publicKey,
        entryFee: ENTRY_FEE,
        maxPlayers: 3,
        rakeBps: RAKE_BPS,
        nonce: CANCEL_NONCE,
      });
      await sendTx([ix], [authority]);

      const joined: { kp: Keypair; token: PublicKey }[] = [];
      for (let i = 0; i < 2; i++) {
        const player = await fundedPlayer();
        await sendTx(
          [
            buildJoinMatchIx({
              programId,
              player: player.kp.publicKey,
              matchPda,
              vault,
              playerToken: player.token,
            }),
          ],
          [player.kp],
        );
        joined.push(player);
      }

      const match = await readMatch(matchPda);
      assert.equal(match.status, MatchStatus.Open, "2 of 3 seats: still Open");
      assert.equal(await tokenBalance(vault), ENTRY_FEE * 2n);

      await sendTx(
        [
          buildCancelMatchIx({
            programId,
            authority: authority.publicKey,
            matchPda,
            vault,
            refundTokenAccounts: match.players.map((p) =>
              deriveAta(p, mintKp.publicKey),
            ),
          }),
        ],
        [authority],
      );

      assert.equal(await tokenBalance(vault), 0n);
      for (const player of joined) {
        assert.equal(
          await tokenBalance(player.token),
          ENTRY_FEE,
          "every staker should be made whole",
        );
      }
      assert.equal((await readMatch(matchPda)).status, MatchStatus.Cancelled);
    });
  });
});
