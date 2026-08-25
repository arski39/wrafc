import type { ClientMessage, ServerMessage } from "../types/protocol";

let ws: WebSocket;
let seq = 0;

const cb: {
  nonceChallenge?: (nonce: string) => void;
  authOk?: () => void;
  authFail?: (reason: string) => void;
  matchStart?: (msg: Extract<ServerMessage, { type: "match_start" }>) => void;
  snapshot?: (msg: Extract<ServerMessage, { type: "snapshot" }>) => void;
  matchEnd?: (msg: Extract<ServerMessage, { type: "match_end" }>) => void;
} = {};

export function connect(url: string): void {
  ws = new WebSocket(url);
  ws.onerror = () => cb.authFail?.("Connection failed");
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as ServerMessage;
    switch (msg.type) {
      case "nonce_challenge": cb.nonceChallenge?.(msg.nonce); break;
      case "auth_ok": cb.authOk?.(); break;
      case "auth_fail": cb.authFail?.(msg.reason); break;
      case "match_start": cb.matchStart?.(msg); break;
      case "snapshot": cb.snapshot?.(msg); break;
      case "match_end": cb.matchEnd?.(msg); break;
    }
  };
}

export function onNonceChallenge(fn: (nonce: string) => void) { cb.nonceChallenge = fn; }
export function onAuthOk(fn: () => void) { cb.authOk = fn; }
export function onAuthFail(fn: (reason: string) => void) { cb.authFail = fn; }
export function onMatchStart(fn: (msg: Extract<ServerMessage, { type: "match_start" }>) => void) { cb.matchStart = fn; }
export function onSnapshot(fn: (msg: Extract<ServerMessage, { type: "snapshot" }>) => void) { cb.snapshot = fn; }
export function onMatchEnd(fn: (msg: Extract<ServerMessage, { type: "match_end" }>) => void) { cb.matchEnd = fn; }

function send(msg: ClientMessage) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

export function sendAuth(walletPubkey: string, sig: string) {
  send({ type: "auth", walletPubkey, sig });
}

export function sendJoinQueue(onchainTxSig?: string) {
  send({ type: "join_queue", onchainTxSig });
}

export function sendInput(dx: number, dy: number) {
  send({ type: "input", dx, dy, seq: seq++ });
}

export function sendSplit() {
  send({ type: "split" });
}
