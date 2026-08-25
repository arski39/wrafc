export interface Vec2 {
  x: number;
  y: number;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function massToRadius(mass: number): number {
  return Math.sqrt(mass) * 4;
}

export function massToSpeed(mass: number, base: number, min: number): number {
  return Math.max(min, base - Math.log2(mass) * 8);
}

export function clampToCircle(p: Vec2, r: number, worldR: number): void {
  const d = Math.hypot(p.x, p.y);
  if (d > worldR - r) {
    p.x = (p.x / d) * (worldR - r);
    p.y = (p.y / d) * (worldR - r);
  }
}
