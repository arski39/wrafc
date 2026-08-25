import type { Vec2 } from "./physics";

export class Player {
  id: string;
  name: string;
  pos: Vec2 = { x: 0, y: 0 };
  vel: Vec2 = { x: 0, y: 0 };
  targetDir: Vec2 = { x: 0, y: 0 };
  mass: number;
  alive = true;
  score = 0;
  lastSeq = 0;

  constructor(id: string, name: string, startMass: number, spawn: Vec2) {
    this.id = id;
    this.name = name;
    this.mass = startMass;
    this.pos = { ...spawn };
  }

  get radius(): number {
    return Math.sqrt(this.mass) * 4;
  }
}
