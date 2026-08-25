import * as socket from "../net/socket";
import { joinMatchOnChain } from "../chain/joinMatch";

interface PhantomProvider {
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  publicKey: { toBase58(): string } | null;
  isConnected: boolean;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
  }
}

// Must match server/src/auth.ts AUTH_PREFIX
const AUTH_PREFIX = "Orb Arena\nAuth: ";

function getProvider(): PhantomProvider | null {
  return window.phantom?.solana ?? null;
}

export class Lobby {
  private el: HTMLElement;
  private status: HTMLElement;
  private btnConnect: HTMLButtonElement;
  private btnJoin: HTMLButtonElement;

  private provider: PhantomProvider | null = null;
  private pubkey = "";

  constructor() {
    this.el = document.createElement("div");
    this.el.id = "lobby";
    this.el.style.cssText =
      "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;" +
      "justify-content:center;background:#0a0a14;color:#fff;font-family:sans-serif;gap:1rem;";

    this.el.innerHTML = `
      <h1 style="font-size:3rem;margin:0">Orb Arena</h1>
      <p id="lobby-status" style="margin:0;opacity:.7;min-height:1.4em;text-align:center"></p>
      <button id="btn-connect"
        style="padding:.75rem 2rem;font-size:1.1rem;cursor:pointer;border-radius:8px">
        Connect Wallet
      </button>
      <button id="btn-join"
        style="padding:.75rem 2rem;font-size:1.1rem;cursor:pointer;border-radius:8px;display:none">
        Join Queue
      </button>
    `;
    document.body.appendChild(this.el);

    this.status = this.el.querySelector("#lobby-status")!;
    this.btnConnect = this.el.querySelector("#btn-connect")! as HTMLButtonElement;
    this.btnJoin = this.el.querySelector("#btn-join")! as HTMLButtonElement;

    this.btnConnect.addEventListener("click", () => void this.connectWallet());
    this.btnJoin.addEventListener("click", () => void this.joinQueue());

    socket.onNonceChallenge((nonce) => void this.handleNonce(nonce));
    socket.onAuthOk(() => this.showReady());
    socket.onAuthFail((reason) => this.setStatus(`Auth failed: ${reason}`, true));
  }

  private setStatus(msg: string, isError = false) {
    this.status.textContent = msg;
    this.status.style.color = isError ? "#f66" : "rgba(255,255,255,.7)";
  }

  private async connectWallet() {
    const provider = getProvider();
    if (!provider) {
      this.setStatus("Phantom not found — install it at phantom.app", true);
      return;
    }
    this.provider = provider;
    this.btnConnect.disabled = true;
    this.setStatus("Connecting wallet…");
    try {
      const { publicKey } = await provider.connect();
      this.pubkey = publicKey.toBase58();
      this.setStatus(`${this.pubkey.slice(0, 8)}… connected — authenticating…`);
      socket.connect(import.meta.env.VITE_WS_URL ?? "ws://localhost:8080");
    } catch (e) {
      this.setStatus(`Wallet connection failed: ${String(e)}`, true);
      this.btnConnect.disabled = false;
    }
  }

  private async handleNonce(nonce: string) {
    if (!this.provider) return;
    this.setStatus("Sign the auth message in Phantom…");
    try {
      const message = new TextEncoder().encode(AUTH_PREFIX + nonce);
      const { signature } = await this.provider.signMessage(message);
      const sigBase64 = btoa(Array.from(signature, (b) => String.fromCharCode(b)).join(""));
      socket.sendAuth(this.pubkey, sigBase64);
      this.setStatus("Verifying signature…");
    } catch (e) {
      this.setStatus(`Signing failed: ${String(e)}`, true);
    }
  }

  private showReady() {
    this.setStatus(`Authenticated as ${this.pubkey.slice(0, 8)}…`);
    this.btnConnect.style.display = "none";
    this.btnJoin.style.display = "block";
  }

  private async joinQueue() {
    this.btnJoin.disabled = true;
    this.setStatus("Joining queue…");
    // joinMatchOnChain is a Phase 2 stub — returns null until vault ATA is wired
    const txSig = await joinMatchOnChain("").catch(() => null);
    socket.sendJoinQueue(txSig ?? undefined);
    this.setStatus("In queue — waiting for opponent…");
  }

  show() { this.el.style.display = "flex"; }
  hide() { this.el.style.display = "none"; }
}
