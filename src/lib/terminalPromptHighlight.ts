import type { IBufferCell, IDecoration, IMarker, Terminal } from "@xterm/xterm";

export const TERMINAL_PROMPT_COLOR = "#047857";
const MAX_PROMPT_RANGES = 128;
const MAX_READBACK_LINES = 8;
const MAX_READBACK_CHARS = 8192;
// Recognize common shell prompts, including a command already echoed after them.
const SHELL_PROMPT = /^(?:[\w.-]+@[\w.-]+:(?:~|\/)[^\r\n]*?[$#>]|\[[\w.-]+@[\w.-]+ [^\]\r\n]+\][$#>])(?=\s|$)/;

type ScreenLine = { row: number; text: string; wrapped: boolean };
type PromptRange = { marker: IMarker; decoration: IDecoration; x: number; width: number; text: string };

function usesDefaultColors(cell: IBufferCell) {
  return cell.isFgDefault() && cell.isBgDefault() && !cell.isInverse() && !cell.isInvisible();
}

/** Add a local fallback color to plain prompts without altering SSH data or ANSI styles. */
export class TerminalPromptHighlight {
  private ranges: PromptRange[] = [];
  private cols: number;

  constructor(private readonly terminal: Terminal) {
    this.cols = terminal.cols;
  }

  /** Bounded decoded tail, shared with cwd/interactive-screen detection by the caller. */
  readback(): string {
    const buffer = this.terminal.buffer.active;
    if (buffer.type !== "normal") { this.clear(); return ""; }
    if (this.cols !== this.terminal.cols) {
      this.clear();
      this.cols = this.terminal.cols;
    }
    const cell = buffer.getNullCell();
    this.ranges = this.ranges.filter((range) => {
      if (range.marker.isDisposed) return false;
      if (range.marker.line < buffer.baseY || this.matches(range, cell)) return true;
      this.disposeRange(range);
      return false;
    });

    const lines: ScreenLine[] = [];
    const end = buffer.baseY + buffer.cursorY;
    let budget = MAX_READBACK_CHARS;
    for (let row = end; row >= Math.max(0, end - MAX_READBACK_LINES + 1) && budget > 0; row--) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const text = line.translateToString(false, 0, Math.min(this.terminal.cols, budget));
      lines.unshift({ row, text, wrapped: line.isWrapped });
      budget -= text.length;
    }
    for (let index = 0; index < lines.length; index++) {
      const start = index;
      let text = lines[index].text;
      while (index + 1 < lines.length && lines[index + 1].wrapped) text += lines[++index].text;
      // An incomplete wrapped prefix cannot reliably be recognized.
      if (lines[start].wrapped) continue;
      const prompt = text.match(SHELL_PROMPT)?.[0];
      if (!prompt) continue;
      let remaining = prompt.length;
      for (let part = start; part <= index && remaining > 0; part++) {
        const row = lines[part].row;
        const line = buffer.getLine(row)!;
        let run = -1;
        let x = 0;
        while (x < this.terminal.cols && remaining > 0) {
          const value = line.getCell(x, cell);
          if (!value) break;
          const width = value.getWidth();
          if (width === 0) { x++; continue; }
          if (usesDefaultColors(value)) {
            if (run < 0) run = x;
          } else if (run >= 0) {
            this.paint(row, run, x - run);
            run = -1;
          }
          remaining -= (value.getChars() || " ").length;
          x += width;
        }
        if (run >= 0) this.paint(row, run, x - run);
      }
    }
    while (this.ranges.length > MAX_PROMPT_RANGES) this.disposeRange(this.ranges.shift()!);
    return lines.map((line) => line.text.trimEnd()).join("\n").slice(-MAX_READBACK_CHARS);
  }

  clear() {
    for (const range of this.ranges) this.disposeRange(range);
    this.ranges = [];
  }

  private paint(row: number, x: number, width: number) {
    if (this.ranges.some((range) => range.marker.line === row && range.x === x && range.width === width)) return;
    const buffer = this.terminal.buffer.active;
    const marker = this.terminal.registerMarker(row - buffer.baseY - buffer.cursorY);
    if (!marker) return;
    const decoration = this.terminal.registerDecoration({ marker, x, width, foregroundColor: TERMINAL_PROMPT_COLOR, layer: "bottom" });
    if (!decoration) { marker.dispose(); return; }
    const text = buffer.getLine(row)?.translateToString(false, x, x + width) ?? "";
    this.ranges.push({ marker, decoration, x, width, text });
  }

  private matches(range: PromptRange, cell: IBufferCell) {
    const line = this.terminal.buffer.active.getLine(range.marker.line);
    if (!line || line.translateToString(false, range.x, range.x + range.width) !== range.text) return false;
    for (let x = range.x; x < range.x + range.width; x++) {
      const value = line.getCell(x, cell);
      if (!value || !usesDefaultColors(value)) return false;
    }
    return true;
  }

  private disposeRange(range: PromptRange) {
    range.decoration.dispose();
    range.marker.dispose();
  }
}
