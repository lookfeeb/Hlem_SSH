import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";

export const TERMINAL_INPUT_COLOR = "#1d4ed8";
const MAX_INPUT_CHARS = 4096;
const MAX_HISTORY_LINES = 128;
const ECHO_TIMEOUT_MS = 5000;
type PaintedRange = { marker: IMarker; decoration: IDecoration; x: number; width: number; text: string };
type Echo = { anchor: IMarker; x: number; prefix: string; text: string; sealed: boolean; expires: number; painted: PaintedRange[] };

/** Color only text actually present in the server-rendered screen. Never echo locally. */
export class TerminalInputHighlight {
  private current: Echo | undefined;
  private pending: Echo[] = [];
  private history: PaintedRange[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly terminal: Terminal) {}

  input(data: string, canStart = true) {
    if (this.terminal.buffer.active.type !== "normal") { this.clear(); return; }
    const plain = data.replace(/\x1b\[200~|\x1b\[201~/g, "");
    // Cursor editing, completion and TUI controls have no reliable echo mapping.
    if (/[\x00-\x07\x09\x0b\x0c\x0e-\x1f]/.test(plain)) { this.cancelCurrent(); return; }
    if (!this.current) {
      if (!canStart || !/[^\r\n\x08\x7f]/.test(plain)) return;
      const buffer = this.terminal.buffer.active;
      const anchor = this.terminal.registerMarker(0);
      if (!anchor || buffer.cursorX >= this.terminal.cols) { anchor?.dispose(); return; }
      this.current = { anchor, x: buffer.cursorX, prefix: buffer.getLine(anchor.line)?.translateToString(false, 0, buffer.cursorX) ?? "", text: "", sealed: false, expires: Date.now() + ECHO_TIMEOUT_MS, painted: [] };
      this.pending.push(this.current);
    }
    const echo = this.current;
    for (const char of plain) {
      if (char === "\r" || char === "\n") { echo.sealed = true; this.current = undefined; break; }
      if (char === "\x7f" || char === "\x08") echo.text = Array.from(echo.text).slice(0, -1).join("");
      else echo.text += char;
      if (echo.text.length > MAX_INPUT_CHARS) { this.cancelCurrent(); return; }
    }
    echo.expires = Date.now() + ECHO_TIMEOUT_MS;
    while (this.pending.length > 8) this.release(this.pending.shift()!);
    this.scheduleExpiry();
  }

  parsed() {
    if (this.terminal.buffer.active.type !== "normal") { this.clear(); return; }
    // Commands in scrollback cannot be overwritten by VT cursor commands. Only
    // inspect decorated screen rows, so continuous logs don't rescan history.
    const buffer = this.terminal.buffer.active;
    this.history = this.history.filter((range) => {
      if (range.marker.isDisposed) return false;
      if (range.marker.line < buffer.baseY || this.rangeMatches(range)) return true;
      this.disposeRanges([range]);
      return false;
    });
    if (!this.pending.length) return;
    const cell = buffer.getNullCell();
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const echo = this.pending[index];
      const first = buffer.getLine(echo.anchor.line);
      if (echo.anchor.isDisposed || Date.now() > echo.expires || !first || first.translateToString(false, 0, echo.x) !== echo.prefix) {
        this.pending.splice(index, 1); this.release(echo); continue;
      }
      const ranges: { line: number; x: number; width: number }[] = [];
      let matched = 0;
      let row = echo.anchor.line;
      let x = echo.x;
      while (matched < echo.text.length && row < echo.anchor.line + 8) {
        const line = buffer.getLine(row);
        if (!line || (row !== echo.anchor.line && !line.isWrapped)) break;
        const start = x;
        while (x < this.terminal.cols && matched < echo.text.length) {
          const value = line.getCell(x, cell);
          if (!value) break;
          const width = value.getWidth();
          if (width === 0) { x++; continue; }
          const chars = value.getChars() || " ";
          if (!echo.text.startsWith(chars, matched)) break;
          matched += chars.length; x += width;
        }
        if (x > start) ranges.push({ line: row, x: start, width: x - start });
        if (x < this.terminal.cols) break;
        row++; x = 0;
      }
      if (matched !== echo.text.length) {
        if (echo.painted.some((range) => !this.rangeMatches(range))) {
          this.disposeRanges(echo.painted); echo.painted = [];
        }
        continue;
      }
      const unchanged = echo.painted.length === ranges.length && echo.painted.every((paint, i) => paint.marker.line === ranges[i].line && paint.x === ranges[i].x && paint.width === ranges[i].width);
      if (!unchanged) {
        this.disposeRanges(echo.painted); echo.painted = [];
        for (const range of ranges) {
          const marker = this.terminal.registerMarker(range.line - buffer.baseY - buffer.cursorY);
          if (!marker) continue;
          const decoration = this.terminal.registerDecoration({ marker, x: range.x, width: range.width, foregroundColor: TERMINAL_INPUT_COLOR, layer: "bottom" });
          if (!decoration) { marker.dispose(); continue; }
          decoration.onRender((element) => { element.dataset.helmWidth = String(range.width); element.dataset.helmInput = "true"; });
          const text = buffer.getLine(range.line)?.translateToString(false, range.x, range.x + range.width) ?? "";
          echo.painted.push({ marker, decoration, x: range.x, width: range.width, text });
        }
      }
      if (echo.sealed) {
        this.history.push(...echo.painted); echo.painted = [];
        this.pending.splice(index, 1); this.release(echo);
      }
    }
    while (this.history.length > MAX_HISTORY_LINES) this.disposeRanges([this.history.shift()!]);
  }

  clear() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const echo of this.pending) this.release(echo);
    this.pending = []; this.current = undefined;
    this.disposeRanges(this.history); this.history = [];
  }
  private cancelCurrent() {
    if (!this.current) return;
    const echo = this.current;
    this.pending = this.pending.filter((item) => item !== echo);
    this.release(echo);
  }
  private release(echo: Echo) {
    if (this.current === echo) this.current = undefined;
    echo.text = ""; echo.prefix = "";
    echo.anchor.dispose(); this.disposeRanges(echo.painted);
  }
  private disposeRanges(ranges: PaintedRange[]) {
    for (const range of ranges) { range.decoration.dispose(); range.marker.dispose(); }
  }
  private rangeMatches(range: PaintedRange) {
    return !range.marker.isDisposed && this.terminal.buffer.active.getLine(range.marker.line)
      ?.translateToString(false, range.x, range.x + range.width) === range.text;
  }
  private scheduleExpiry() {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.parsed();
      if (this.pending.length) this.scheduleExpiry();
    }, ECHO_TIMEOUT_MS);
  }
}
