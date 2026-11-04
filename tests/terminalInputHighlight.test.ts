import assert from "node:assert/strict";
import test from "node:test";
import { Terminal, type IDecorationOptions, type IDecoration } from "@xterm/xterm";
import { TerminalInputHighlight, TERMINAL_INPUT_COLOR } from "../src/lib/terminalInputHighlight";

function fixture(cols = 80) {
  const terminal = new Terminal({ cols, rows: 24, allowProposedApi: true });
  const highlighter = new TerminalInputHighlight(terminal);
  const decorations: IDecorationOptions[] = [];
  const liveDecorations = new Set<IDecoration>();
  const register = terminal.registerDecoration.bind(terminal);
  terminal.registerDecoration = (options) => {
    decorations.push(options);
    const decoration = register(options);
    if (decoration) { liveDecorations.add(decoration); decoration.onDispose(() => liveDecorations.delete(decoration)); }
    return decoration;
  };
  const listener = terminal.onWriteParsed(() => highlighter.parsed());
  return { terminal, highlighter, decorations, liveDecorations,
    write: (text: string | Uint8Array) => new Promise<void>((resolve) => terminal.write(text, resolve)),
    dispose: () => { listener.dispose(); highlighter.clear(); terminal.dispose(); },
  };
}

test("input highlighting waits for server echo, preserves ANSI and covers wide characters", async () => {
  const f = fixture();
  try {
    await f.write("user@host:~$ ");
    f.highlighter.input("echo 中文\r");
    assert.equal(f.decorations.length, 0);
    await f.write("echo 中");
    assert.equal(f.decorations.length, 0);
    await f.write("文\r\n\x1b[31mserver error\x1b[0m\r\n");
    assert.equal(f.decorations.length, 1);
    assert.equal(f.decorations[0].foregroundColor, TERMINAL_INPUT_COLOR);
    assert.equal(f.decorations[0].width, 9);
    assert.equal(f.terminal.buffer.active.getLine(1)?.getCell(0)?.getFgColor(), 1);
  } finally { f.dispose(); }
});

test("server overwrites remove input color, and backspace shrinks the marked cells", async () => {
  const f = fixture();
  try {
    await f.write("$ ");
    f.highlighter.input("abc");
    await f.write("abc");
    f.highlighter.input("\x7f");
    await f.write("\b \b");
    assert.equal(f.decorations.at(-1)?.width, 2);
    assert.equal(f.liveDecorations.size, 1);
    f.highlighter.input("\r");
    await f.write("\r\n");
    await f.write("\x1b[1A\r\x1b[31mserver overwrote command\x1b[0m");
    assert.equal(f.liveDecorations.size, 0);
    assert.equal(f.terminal.buffer.active.getLine(0)?.getCell(2)?.getFgColor(), 1);
  } finally { f.dispose(); }
});

test("hidden password input never appears or gets decorated", async () => {
  const f = fixture();
  try {
    await f.write("Password: ");
    f.highlighter.input("do-not-display\r");
    await f.write("\r\nPermission denied\r\n");
    assert.equal(f.decorations.length, 0);
    assert.ok(!f.terminal.buffer.active.getLine(0)?.translateToString(true).includes("do-not-display"));
  } finally { f.dispose(); }
});

test("wrapped input is colored by cells and cursor controls cancel ambiguous mappings", async () => {
  const f = fixture(12);
  try {
    await f.write("user$ ");
    f.highlighter.input("abcdefghij\r");
    await f.write("abcdefghij\r\n");
    assert.deepEqual(f.decorations.map((d) => d.width), [6, 4]);
    f.highlighter.input("pending");
    f.highlighter.input("\x1b[A");
    const count = f.decorations.length;
    await f.write("pending");
    assert.equal(f.decorations.length, count);
    await f.write("\x1b[?1049h");
    f.highlighter.input("text");
    await f.write("text");
    assert.equal(f.decorations.length, count);
  } finally { f.dispose(); }
});
