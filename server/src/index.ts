import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { CONFIG } from "./config";
import { World } from "./engine/World";
import { Player } from "./engine/Player";
import { GameLoop } from "./engine/GameLoop";
import { SessionManager } from "./net/SessionManager";
import { generateSeed } from "./fairness/seedCommit";
import { signMatchResult } from "./chain/signer";
import { settleMatch } from "./chain/settler";
import { genNonce, verifyWalletSig } from "./auth";
import type { ClientMessage, ServerMessage } from "./net/protocol";

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const sessions = new SessionManager();

let waitingQueue: WebSocket[] = [];
let currentWorld: World | null = null;
let matchLoop: GameLoop | null = null;
let snapLoop: GameLoop | null = null;
let matchTimer: NodeJS.Timeout | null = null;
let currentMatchKey = "";

wss.on("connection", (ws) => {
  const session = sessions.add(ws);
  session.nonce = genNonce();
  send(ws, { type: "nonce_challenge", nonce: session.nonce });

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "auth":
        handleAuth(ws, msg);
        break;
      case "join_queue":
        void handleJoinQueue(ws);
        break;
      case "input":
        handleInput(ws, msg);
        break;
    }
  });

  ws.on("close", () => {
    sessions.remove(ws);
    waitingQueue = waitingQueue.filter((c) => c !== ws);
  });
});

function send(ws: WebSocket, msg: ServerMessage) {
  ws.send(JSON.stringify(msg));
}

function handleAuth(ws: WebSocket, msg: Extract<ClientMessage, { type: "auth" }>) {
  const session = sessions.get(ws);
  if (!session?.nonce) {
    ws.terminate();
    return;
  }
  if (!verifyWalletSig(session.nonce, msg.walletPubkey, msg.sig)) {
    send(ws, { type: "auth_fail", reason: "invalid signature" });
    ws.terminate();
    return;
  }
  session.authenticated = true;
  session.walletPubkey = msg.walletPubkey;
  send(ws, { type: "auth_ok" });
  console.log(`[auth] verified wallet=${msg.walletPubkey.slice(0, 8)}…`);
}

async function handleJoinQueue(ws: WebSocket) {
  const session = sessions.get(ws);
  if (!session?.authenticated) {
    send(ws, { type: "auth_fail", reason: "not authenticated" });
    return;
  }
  // TODO (Phase 2): verify on-chain membership once vault ATA is wired
  // if (process.env.GAME_ENV !== "dev" && currentMatchPDA) {
  //   const ok = await verifyOnchainMembership(currentMatchPDA, session.walletPubkey!, onchainTxSig);
  //   if (!ok) { ws.terminate(); return; }
  // }
  waitingQueue.push(ws);
  tryStartMatch();
}

function handleInput(ws: WebSocket, msg: Extract<ClientMessage, { type: "input" }>) {
  const session = sessions.get(ws);
  if (!session?.playerId || !currentWorld) return;
  const p = currentWorld.players.get(session.playerId);
  if (!p || msg.seq <= p.lastSeq) return;
  p.lastSeq = msg.seq;
  const len = Math.hypot(msg.dx, msg.dy) || 1;
  p.targetDir = { x: msg.dx / len, y: msg.dy / len };
}

function tryStartMatch() {
  if (waitingQueue.length < 2 || currentWorld) return;

  const roster = waitingQueue.splice(0, CONFIG.MAX_PLAYERS_PER_MATCH);
  const { seed, commitHash } = generateSeed();
  currentMatchKey = `match_${Date.now()}`;
  currentWorld = new World(seed);

  console.log(`[match] started key=${currentMatchKey} players=${roster.length} commit=${commitHash}`);

  for (const ws of roster) {
    const session = sessions.get(ws);
    if (!session) continue;
    const id = session.walletPubkey ?? "player_" + Math.random().toString(36).slice(2);
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * CONFIG.WORLD_RADIUS * 0.5;
    const p = new Player(id, id, CONFIG.START_MASS, {
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
    });
    currentWorld.addPlayer(p);
    session.playerId = id;

    send(ws, {
      type: "match_start",
      yourId: id,
      seedCommit: commitHash,
      orbPositions: currentWorld.orbs.map((o) => ({
        id: o.id,
        x: Math.round(o.x),
        y: Math.round(o.y),
      })),
    });
  }

  matchLoop = new GameLoop(CONFIG.TICK_RATE, (dt) => {
    currentWorld?.step(dt);
  });
  matchLoop.start();

  snapLoop = new GameLoop(CONFIG.SNAPSHOT_RATE, () => broadcastSnapshot());
  snapLoop.start();

  matchTimer = setTimeout(endMatch, CONFIG.MATCH_DURATION_MS);
}

function broadcastSnapshot() {
  if (!currentWorld) return;
  const msg: ServerMessage = {
    type: "snapshot",
    tick: currentWorld.tick,
    players: [...currentWorld.players.values()]
      .filter((p) => p.alive)
      .map((p) => ({ id: p.id, x: Math.round(p.pos.x), y: Math.round(p.pos.y), m: Math.round(p.mass) })),
    orbs: currentWorld.orbs.filter((o) => o.active).map((o) => o.id),
  };
  const data = JSON.stringify(msg);
  for (const s of sessions.all()) {
    if (s.playerId) s.ws.send(data);
  }
}

function endMatch() {
  if (!currentWorld) return;

  matchLoop?.stop();
  snapLoop?.stop();
  if (matchTimer) clearTimeout(matchTimer);

  const alive = currentWorld.alivePlayers();
  const winner =
    alive.length >= 1
      ? alive.sort((a, b) => b.mass - a.mass)[0]!
      : [...currentWorld.players.values()].sort((a, b) => b.score - a.score)[0]!;

  const scores: Record<string, number> = {};
  for (const p of currentWorld.players.values()) scores[p.id] = p.score;

  const sig = signMatchResult(currentMatchKey, winner.id, scores);

  for (const s of sessions.all()) {
    if (s.playerId) {
      send(s.ws, {
        type: "match_end",
        winner: winner.id,
        scores,
        sig: Buffer.from(sig).toString("hex"),
      });
    }
  }

  settleMatch(currentMatchKey, winner.id, scores, sig).catch((e) =>
    console.error("[settler] failed:", e),
  );

  currentWorld = null;
  currentMatchKey = "";
}

server.listen(CONFIG.PORT, () => console.log(`[server] listening on :${CONFIG.PORT}`));
