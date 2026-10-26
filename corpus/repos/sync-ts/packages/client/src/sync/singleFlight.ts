/**
 * At most one run of a task at a time: a call while a run is in progress gets that run's
 * promise instead of starting another one.
 */
export class SingleFlight<T> {
  private running: Promise<T> | null = null;

  run(task: () => Promise<T>): Promise<T> {
    if (this.running) return this.running;
    const run = (async () => task())().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  /** The run in progress, if any. */
  get current(): Promise<T> | null {
    return this.running;
  }
}
