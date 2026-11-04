/** Header: low 2 bits = kind; 0x80 = scan metadata present; 0x04 = bare CR. Body is unchanged. */
export function decodeTerminalFrame(buffer: ArrayBuffer) {
  const frame = new Uint8Array(buffer);
  const header = frame[0];
  if (frame.length === 0 || frame.length > 65537 || (header & ~0x87) !== 0 || (!(header & 0x80) && header > 3)) throw new Error("终端二进制帧无效");
  const kind = (["output", "error", "system", "closed"] as const)[header & 3];
  if (kind === "closed" && (frame.length !== 1 || header !== 3)) throw new Error("终端关闭帧无效");
  return { kind, bytes: frame.subarray(1), hasBareCarriageReturn: header & 0x80 ? Boolean(header & 4) : undefined };
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
