export class GameLoop {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tickRate: number,
    private readonly onTick: (dt: number) => void,
  ) {}

  start() {
    const dt = 1 / this.tickRate;
    this.intervalId = setInterval(() => this.onTick(dt), dt * 1000);
  }

  stop() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
