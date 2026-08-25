export type ClientMessage =
  | { type: "auth"; walletPubkey: string; sig: string }
  | { type: "join_queue"; onchainTxSig?: string }
  | { type: "input"; dx: number; dy: number; seq: number }
  | { type: "split" };

export type ServerMessage =
  | { type: "nonce_challenge"; nonce: string }
  | { type: "auth_ok" }
  | { type: "auth_fail"; reason: string }
  | { type: "match_pda"; pda: string }
  | {
      type: "match_start";
      yourId: string;
      seedCommit: string;
      orbPositions: Array<{ id: number; x: number; y: number }>;
    }
  | { type: "snapshot"; tick: number; players: PlayerSnapshot[]; orbs: number[] }
  | { type: "match_end"; winner: string; scores: Record<string, number>; sig: string }
  | { type: "you_died" }
  | { type: "error"; message: string };

export interface PlayerSnapshot {
  id: string;
  x: number;
  y: number;
  m: number;
}
