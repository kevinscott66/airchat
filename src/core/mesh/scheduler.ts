import { log } from '../logger';

export type MeshSchedulerHandlers = {
  onFlush?: () => Promise<void>;
};

export class MeshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly handlers: MeshSchedulerHandlers) {}

  start(intervalMs: number = 30_000): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.handlers.onFlush?.().catch((e) => {
        log.warn('mesh_scheduler_flush_failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
