import { Renderer } from "./render/Renderer";
import { InputManager } from "./input/InputManager";
import { Lobby } from "./ui/Lobby";
import * as socket from "./net/socket";
import type { ServerMessage } from "./types/protocol";

const lobby = new Lobby();
const renderer = new Renderer();
const input = new InputManager();

let myId = "";
let latest: Extract<ServerMessage, { type: "snapshot" }> | null = null;

socket.onMatchStart((msg) => {
  myId = msg.yourId;
  lobby.hide();
  input.attach();
});

socket.onSnapshot((snap) => {
  latest = snap;
});

socket.onMatchEnd((msg) => {
  alert(`Winner: ${msg.winner}`);
});

renderer.app.ticker.add(() => {
  if (!latest) return;
  renderer.render(latest.players, myId);
});

lobby.show();
