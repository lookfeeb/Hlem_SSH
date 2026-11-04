import assert from "node:assert/strict";
import test from "node:test";
import { Terminal, type IDecoration, type IDecorationOptions } from "@xterm/xterm";
import { TerminalInputHighlight, TERMINAL_INPUT_COLOR } from "../src/lib/terminalInputHighlight";
import { TerminalPromptHighlight, TERMINAL_PROMPT_COLOR } from "../src/lib/terminalPromptHighlight";

function fixture(cols = 80) {
  const terminal = new Terminal({ cols, rows: 24, scrollback: 500, allowProposedApi: true });
  const prompt = new TerminalPromptHighlight(terminal);
  const input = new TerminalInputHighlight(terminal);
  const live = new Map<IDecoration, IDecorationOptions>();
  const register = terminal.registerDecoration.bind(terminal);
  terminal.registerDecoration = (options) => {
    const decoration = register(options);
    if (decoration) {
      live.set(decoration, options);
      decoration.onDispose(() => live.delete(decoration));
    }
    return decoration;
  };
  const listener = terminal.onWriteParsed(() => { input.parsed(); prompt.readback(); });
  return {
    terminal, prompt, input, live,
    prompts: () => [...live.values()].filter((item) => item.foregroundColor === TERMINAL_PROMPT_COLOR),
    write: (text: string) => new Promise<void>((resolve) => terminal.write(text, resolve)),
    dispose: () => { listener.dispose(); input.clear(); prompt.clear(); terminal.dispose(); },
  };
}

test("plain shell prompt is green before typing, echoed command stays blue and output keeps ANSI", async () => {
  const f = fixture();
  try {
    await f.write("root@mix:~# ");
    assert.deepEqual(f.prompts().map((p) => [p.marker.line, p.x, p.width]), [[0, 0, 11]]);
    f.input.input("cd /tmp\r");
    await f.write("cd /tmp\r\n\x1b[31mserver error\x1b[0m\r\nroot@mix:/tmp# ");
    assert.equal(f.prompts().length, 2);
    const command = [...f.live.values()].find((p) => p.foregroundColor === TERMINAL_INPUT_COLOR);
    assert.equal(command?.x, 12);
    assert.equal(command?.width, 7);
    assert.equal(f.terminal.buffer.active.getLine(1)?.getCell(0)?.getFgColor(), 1);
    assert.equal(f.terminal.buffer.active.getLine(0)?.translateToString(true), "root@mix:~# cd /tmp");
    assert.equal(f.prompt.readback(), "root@mix:~# cd /tmp\nserver error\nroot@mix:/tmp#");
  } finally { f.dispose(); }
});

test("server-colored prompt cells keep their ANSI colors, including recoloring identical text", async () => {
  const f = fixture();
  try {
    await f.write("\x1b[31mroot@mix\x1b[0m:~# ");
    assert.deepEqual(f.prompts().map((p) => [p.x, p.width]), [[8, 3]]);
    assert.equal(f.terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor(), 1);
    await f.write("\r\x1b[35mroot@mix:~# \x1b[0m");
    assert.equal(f.prompts().length, 0);
    assert.equal(f.terminal.buffer.active.getLine(0)?.getCell(8)?.getFgColor(), 5);
  } finally { f.dispose(); }
});

test("split and wrapped prompts with wide paths color the prompt without the command", async () => {
  const f = fixture(16);
  try {
    await f.write("root@mi");
    assert.equal(f.prompts().length, 0);
    await f.write("x:~/中文目录# cd /tmp");
    assert.deepEqual(f.prompts().map((p) => [p.marker.line, p.x, p.width]), [[0, 0, 16], [1, 0, 5]]);
    const before = f.live.size;
    f.prompt.readback();
    assert.equal(f.live.size, before, "unchanged prompt should reuse decorations");
  } finally { f.dispose(); }
});

test("bracket prompts are supported, while logs, passwords and alternate screens stay untouched", async () => {
  const f = fixture();
  try {
    await f.write("Password: ");
    assert.equal(f.prompts().length, 0);
    await f.write("\r\nINFO root@mix:~# example\r\n[root@mix tmp]# ");
    assert.deepEqual(f.prompts().map((p) => p.marker.line), [2]);
    await f.write("\x1b[?1049hroot@mix:~# ");
    assert.equal(f.prompts().length, 0);
    await f.write("\x1b[?1049l");
    assert.equal(f.prompts().length, 1);
    await f.write("\r\x1b[2Kserver overwrote prompt");
    assert.equal(f.prompts().length, 0);
  } finally { f.dispose(); }
});

test("prompt decorations stay bounded, follow scrollback, and clear on reset or resize", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 140; index++) await f.write(`root@mix:/dir${index}# echo ok\r\n`);
    assert.equal(f.prompts().length, 128);
    assert.ok(f.prompts().every((p) => p.marker.line >= 12));
    f.terminal.resize(24, 24);
    f.prompt.readback();
    assert.ok(f.prompts().length <= 8);
    assert.ok(f.prompts().every((p) => (p.x ?? 0) + (p.width ?? 1) <= 24));
    f.prompt.clear();
    assert.equal(f.live.size, 0);
    assert.equal(f.terminal.markers.length, 0);
    f.terminal.reset();
    f.prompt.readback();
    assert.equal(f.prompts().length, 0);
  } finally { f.dispose(); }
});
