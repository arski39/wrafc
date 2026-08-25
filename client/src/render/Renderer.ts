import { Application, Graphics, Container } from "pixi.js";
import type { PlayerSnapshot } from "../types/protocol";

export class Renderer {
  app: Application;
  worldLayer: Container;
  private gfx: Graphics;

  constructor() {
    this.app = new Application({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: 0x0a0a14,
      resizeTo: window,
    });
    document.body.appendChild(this.app.view as HTMLCanvasElement);
    this.worldLayer = new Container();
    this.app.stage.addChild(this.worldLayer);
    this.gfx = new Graphics();
    this.worldLayer.addChild(this.gfx);
  }

  render(players: PlayerSnapshot[], myId: string) {
    this.gfx.clear();
    for (const p of players) {
      const color = p.id === myId ? 0x00ff88 : 0xff5555;
      const r = Math.sqrt(p.m) * 4;
      // Offset by screen center so (0,0) is center of viewport
      this.gfx
        .beginFill(color)
        .drawCircle(p.x + window.innerWidth / 2, p.y + window.innerHeight / 2, r)
        .endFill();
    }
  }
}
