import type { Logger } from "./logger.js";

export interface PeriodicTaskOptions {
  readonly name: string;
  /** Wait between runs. A run that reports more work is followed by the next one at once. */
  readonly intervalMs: number;
  /** One unit of work; resolves true when there is more work waiting. */
  readonly run: () => Promise<boolean>;
  readonly logger: Logger;
}

/**
 * Runs a background job in a loop inside the server process: one run at a time, a pause between
 * runs, failures logged and retried after the pause. `stop()` cancels the next run and waits for
 * the current one, so shutdown never cuts a run off in the middle.
 */
export class PeriodicTask {
  private readonly options: PeriodicTaskOptions;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private running = false;

  constructor(options: PeriodicTaskOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.current;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.current = this.tick().finally(() => {
        this.current = null;
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let more = false;
    try {
      more = await this.options.run();
    } catch (err) {
      this.options.logger.error({ err, task: this.options.name }, "background task failed");
    }
    this.schedule(more ? 0 : this.options.intervalMs);
  }
}
