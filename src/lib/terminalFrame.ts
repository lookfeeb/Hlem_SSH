/** Per-terminal native channel: one kind byte followed by the original bytes. */
export function decodeTerminalFrame(buffer: ArrayBuffer) {
  const frame = new Uint8Array(buffer);
  if (frame.length === 0 || frame[0] > 3) throw new Error("终端二进制帧无效");
  const kind = (["output", "error", "system", "closed"] as const)[frame[0]];
  if (kind === "closed" && frame.length !== 1) throw new Error("终端关闭帧无效");
  return { kind, bytes: frame.subarray(1) };
}

/** Cumulative acknowledgments tolerate command completion reordering. */
export class TerminalConsumption {
  private consumed = 0;
  private acknowledged = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  constructor(private readonly send: (consumed: number) => void) {}

  consume(bytes: number) {
    if (this.closed) return;
    this.consumed += bytes;
    if (this.consumed - this.acknowledged >= 64 * 1024) this.flush();
    else if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), 8);
  }

  private flush() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.consumed === this.acknowledged) return;
    this.acknowledged = this.consumed;
    this.send(this.consumed);
  }

  close() {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
