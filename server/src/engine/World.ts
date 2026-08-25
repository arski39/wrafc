import { Player } from "./Player";
import type { Orb } from "./Orb";
import { CONFIG } from "../config";
import { dist, clampToCircle, massToSpeed } from "./physics";

export class World {
  players = new Map<string, Player>();
  orbs: Orb[] = [];
  tick = 0;

  constructor(seed: Uint8Array) {
    this.spawnOrbs(seed);
  }

  private spawnOrbs(seed: Uint8Array) {
    let s = seed.reduce((a, b) => a + b, 0) || 12345;
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let i = 0; i < CONFIG.ORB_COUNT; i++) {
      const angle = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * CONFIG.WORLD_RADIUS;
      this.orbs.push({ id: i, x: Math.cos(angle) * r, y: Math.sin(angle) * r, active: true });
    }
  }

  addPlayer(p: Player) {
    this.players.set(p.id, p);
  }

  step(dt: number) {
    this.tick++;

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const speed = massToSpeed(p.mass, CONFIG.MOVE_SPEED_BASE, CONFIG.MOVE_SPEED_MIN);
      p.pos.x += p.targetDir.x * speed * dt;
      p.pos.y += p.targetDir.y * speed * dt;
      clampToCircle(p.pos, p.radius, CONFIG.WORLD_RADIUS);
    }

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (const orb of this.orbs) {
        if (!orb.active) continue;
        if (dist(p.pos, orb) < p.radius) {
          orb.active = false;
          p.mass += CONFIG.ORB_VALUE;
          p.score += 1;
        }
      }
    }

    const list = [...this.players.values()].filter((p) => p.alive);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const d = dist(a.pos, b.pos);
        if (d < Math.max(a.radius, b.radius)) {
          const big = a.mass > b.mass ? a : b;
          const small = big === a ? b : a;
          if (big.mass > small.mass * CONFIG.EAT_RATIO) {
            big.mass += small.mass;
            small.alive = false;
          }
        }
      }
    }

    // Respawn a fraction of consumed orbs periodically (deterministic-enough for gameplay)
    if (this.tick % 100 === 0) {
      let seed = this.tick;
      for (const orb of this.orbs) {
        if (!orb.active) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          if (seed / 0x7fffffff < 0.05) orb.active = true;
        }
      }
    }
  }

  alivePlayers(): Player[] {
    return [...this.players.values()].filter((p) => p.alive);
  }
}
