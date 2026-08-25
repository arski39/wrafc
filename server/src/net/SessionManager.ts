import type { WebSocket } from "ws";

export interface Session {
  ws: WebSocket;
  nonce?: string;
  playerId?: string;
  walletPubkey?: string;
  authenticated: boolean;
}

export class SessionManager {
  private sessions = new Map<WebSocket, Session>();

  add(ws: WebSocket): Session {
    const session: Session = { ws, authenticated: false };
    this.sessions.set(ws, session);
    return session;
  }

  get(ws: WebSocket): Session | undefined {
    return this.sessions.get(ws);
  }

  remove(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  getByPlayerId(id: string): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.playerId === id) return s;
    }
    return undefined;
  }

  all(): IterableIterator<Session> {
    return this.sessions.values();
  }
}
