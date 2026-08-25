import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  PORT: Number(process.env.PORT ?? 8080),
  TICK_RATE: 20,
  SNAPSHOT_RATE: 15,
  WORLD_RADIUS: 2000,
  ORB_COUNT: 600,
  ORB_VALUE: 1,
  START_MASS: 20,
  MAX_PLAYERS_PER_MATCH: 12,
  ROUND_SECONDS: 300,
  MOVE_SPEED_BASE: 120,
  MOVE_SPEED_MIN: 60,
  EAT_RATIO: 1.15,
  MATCH_DURATION_MS: 5 * 60 * 1000,
} as const;
