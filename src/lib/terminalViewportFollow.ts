export type TerminalViewportFollowScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
};

const SETTLE_DELAY_MS = 60;

/**
 * Keeps a newly attached terminal at the live prompt while xterm parses the
 * startup stream and the host is still being fitted. Following stops as soon
 * as the user explicitly takes control of the viewport.
 */
export class TerminalViewportFollower {
  private terminalId: string | null = null;
  private following = false;
  private generation = 0;
  private timer: number | null = null;
  private firstFrame: number | null = null;
  private secondFrame: number | null = null;

  constructor(
    private readonly scrollToBottom: () => void,
    private readonly scheduler: TerminalViewportFollowScheduler,
  ) {}

  attach(terminalId: string | null) {
    if (this.terminalId === terminalId && this.following === Boolean(terminalId)) return;
    this.cancelScheduledSettle();
    this.generation += 1;
    this.terminalId = terminalId;
    this.following = Boolean(terminalId);
    if (this.following) this.scheduleSettle(0);
  }

  shouldFollow(terminalId: string | null) {
    return Boolean(terminalId) && this.following && this.terminalId === terminalId;
  }

  handleWriteComplete(terminalId: string | null) {
    if (!this.shouldFollow(terminalId)) return;
    this.scrollToBottom();
    this.scheduleSettle(SETTLE_DELAY_MS);
  }

  handleLayoutComplete(terminalId: string | null) {
    if (!this.shouldFollow(terminalId)) return;
    this.scheduleSettle(0);
  }

  detach(terminalId: string | null) {
    if (!this.shouldFollow(terminalId)) return;
    this.following = false;
    this.generation += 1;
    this.cancelScheduledSettle();
  }

  dispose() {
    this.following = false;
    this.terminalId = null;
    this.generation += 1;
    this.cancelScheduledSettle();
  }

  private scheduleSettle(delayMs: number) {
    this.cancelScheduledSettle();
    const generation = this.generation;
    const beginFrames = () => {
      this.timer = null;
      if (!this.isCurrent(generation)) return;
      this.firstFrame = this.scheduler.requestAnimationFrame(() => {
        this.firstFrame = null;
        if (!this.isCurrent(generation)) return;
        this.secondFrame = this.scheduler.requestAnimationFrame(() => {
          this.secondFrame = null;
          if (this.isCurrent(generation)) this.scrollToBottom();
        });
      });
    };

    if (delayMs > 0) {
      this.timer = this.scheduler.setTimeout(beginFrames, delayMs);
    } else {
      beginFrames();
    }
  }

  private isCurrent(generation: number) {
    return this.following && this.generation === generation && Boolean(this.terminalId);
  }

  private cancelScheduledSettle() {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.firstFrame !== null) {
      this.scheduler.cancelAnimationFrame(this.firstFrame);
      this.firstFrame = null;
    }
    if (this.secondFrame !== null) {
      this.scheduler.cancelAnimationFrame(this.secondFrame);
      this.secondFrame = null;
    }
  }
}
