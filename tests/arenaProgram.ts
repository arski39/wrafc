// Proves the hand-rolled bindings in OpenFrontIO/src/server/arena/arenaProgram.ts.
//
// The game server does not use @coral-xyz/anchor — it builds arena instructions
// byte by byte so the browser half of the wager flow stays small. That trades a
// generated coder for constants that can silently drift from the program. This
// suite closes that gap from both ends:
//
//   1. every constant is diffed against the generated target/idl/arena.json, so
//      a program change that moves a discriminator or a field fails here;
//   2. the create_match instruction the server would actually send is executed
//      against the real program in bankrun and the resulting account decoded
//      through the same offset table, so the bytes are proven, not just typed.
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
  createInitializeMint2Instruction,
} from "@solana/spl-token";
import { startAnchor } from "anchor-bankrun";
import { ProgramTestContext } from "solana-bankrun";
import { assert } from "chai";
import { createHash } from "crypto";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID as ARENA_ATA_PROGRAM_ID,
  IX_DISCRIMINATOR,
  MATCH_ACCOUNT_DISCRIMINATOR,
  MATCH_ACCOUNT_LAYOUT,
  MATCH_ACCOUNT_SIZE,
  MAX_PLAYERS,
  MAX_RAKE_BPS,
  MatchStatus,
  TOKEN_PROGRAM_ID as ARENA_TOKEN_PROGRAM_ID,
  buildCreateMatchIx,
  deriveMatchPda,
  deriveVaultAta,
} from "../OpenFrontIO/src/server/arena/arenaProgram";

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
});
