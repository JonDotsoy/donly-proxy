/** Counting semaphore: at most `limit` holders at once, the rest wait in arrival order. */
export class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(readonly limit: number) {}

  /** Resolves with a `release` function once a place is free. Call it exactly once. */
  async acquire() {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next(); // hands the place over without freeing it
      else this.active--;
    };
  }
}
