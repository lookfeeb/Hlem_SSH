import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTerminalDirect,
  forgetTerminalDirect,
  registerTerminalSink,
  writeTerminalEntryDirect,
  terminalReplaySnapshot,
} from "../src/lib/terminalRegistry";
import type { TerminalEntry } from "../src/types";

function entry(id: string, content: string): TerminalEntry {
  return {
    id,
    kind: "output",
    content,
    timestamp: "00:00:00",
  };
}

test("binary stderr chunks are not deduplicated and replay storage is byte bounded", () => {
  const terminalId = "binary-replay";
  const replayed: TerminalEntry[] = [];
  try {
    for (let index = 0; index < 80; index++) {
      writeTerminalEntryDirect(terminalId, {...entry(String(index), ""), kind: "error", dataBytes: new Uint8Array(65536).fill(index)});
    }
    registerTerminalSink(terminalId, { writeEntry: (item) => replayed.push(item) });
    assert.equal(replayed.length, 64);
    assert.equal(replayed[0].dataBytes![0], 16);
    assert.equal(replayed[63].dataBytes![0], 79);
  } finally { forgetTerminalDirect(terminalId); }
});

test("aggregate replay memory stays bounded while live output keeps flowing", () => {
  const ids = Array.from({length: 40}, (_, i) => `memory-${i}`);
  let consumed = 0;
  try {
    for (const id of ids) {
      for (let i = 0; i < 32; i++) writeTerminalEntryDirect(id, {...entry(String(i), ""), dataBytes: new Uint8Array(65536)}, () => consumed++);
    }
    const snapshot = terminalReplaySnapshot();
    assert.ok(snapshot.bytes <= snapshot.maxBytes);
    assert.ok(snapshot.terminals <= 32);
    assert.equal(consumed, 40 * 32);
    let liveBytes: Uint8Array | undefined;
    registerTerminalSink(ids[0], {writeEntry: (item, done) => { liveBytes = item.dataBytes; done?.(); }});
    const tinyView = new Uint8Array(8 * 1024 * 1024).subarray(0, 16);
    writeTerminalEntryDirect(ids[0], {...entry("oversized-backing", ""), dataBytes: tinyView});
    assert.equal(liveBytes, tinyView);
    assert.ok(terminalReplaySnapshot().bytes <= snapshot.maxBytes);
  } finally { ids.forEach(forgetTerminalDirect); }
  assert.equal(terminalReplaySnapshot().bytes, 0);
});

test("terminal output remains replayable after an xterm sink is rebuilt", () => {
  const terminalId = "terminal-replay-after-remount";
  const firstSinkEntries: string[] = [];
  const secondSinkEntries: string[] = [];

  try {
    writeTerminalEntryDirect(terminalId, entry("motd", "Welcome to Ubuntu\r\n"));
    const unregisterFirst = registerTerminalSink(terminalId, {
      writeEntry: (item) => firstSinkEntries.push(item.content),
    });
    writeTerminalEntryDirect(terminalId, entry("prompt", "root@host:~# "));
    unregisterFirst();

    registerTerminalSink(terminalId, {
      writeEntry: (item) => secondSinkEntries.push(item.content),
    });

    assert.deepEqual(firstSinkEntries, ["Welcome to Ubuntu\r\n", "root@host:~# "]);
    assert.deepEqual(secondSinkEntries, ["Welcome to Ubuntu\r\n", "root@host:~# "]);
  } finally {
    forgetTerminalDirect(terminalId);
  }
});

test("clearing a terminal also clears its replay history", () => {
  const terminalId = "terminal-clear-replay";
  const replayed: string[] = [];

  try {
    writeTerminalEntryDirect(terminalId, entry("motd", "Welcome to Ubuntu\r\n"));
    clearTerminalDirect(terminalId);
    registerTerminalSink(terminalId, {
      writeEntry: (item) => replayed.push(item.content),
    });
    assert.deepEqual(replayed, []);
  } finally {
    forgetTerminalDirect(terminalId);
  }
});

test("terminal replay history is bounded", () => {
  const terminalId = "terminal-bounded-replay";
  const replayed: string[] = [];

  try {
    for (let index = 0; index < 5000; index += 1) {
      writeTerminalEntryDirect(terminalId, {
        ...entry(`entry-${index}`, `${index}\n`),
        dataBytes: new Uint8Array([0]),
      });
    }
    registerTerminalSink(terminalId, {
      writeEntry: (item) => replayed.push(item.content),
    });
    assert.equal(replayed.length, 4096);
    assert.equal(replayed.at(-1), "4999\n");
  } finally {
    forgetTerminalDirect(terminalId);
  }
});


test("terminal credit follows parser consumption and is never replayed", () => {
  const id = "terminal-consumption";
  let credits = 0;
  let consume: (() => void) | undefined;
  const unlisten = registerTerminalSink(id, { writeEntry: (_entry, done) => { consume = done; } });
  writeTerminalEntryDirect(id, entry("credit", "hello"), () => { credits++; });
  assert.equal(credits, 0);
  consume?.();
  assert.equal(credits, 1);
  unlisten();
  registerTerminalSink(id, { writeEntry: (_entry, done) => { assert.equal(done, undefined); } });
  assert.equal(credits, 1);
  forgetTerminalDirect(id);
  writeTerminalEntryDirect(id, entry("unmounted", "saved"), () => { credits++; });
  assert.equal(credits, 2);
  forgetTerminalDirect(id);
});

test("replay accounts for a shared backing buffer once without copying views", () => {
  const id = "shared-buffer";
  const buffer = new Uint8Array(2 * 1024 * 1024);
  const views = Array.from({length: 100}, (_, index) => buffer.subarray(index * 1024, (index + 1) * 1024));
  const replayed: Uint8Array[] = [];
  try {
    views.forEach((view, index) => writeTerminalEntryDirect(id, {...entry(String(index), ""), dataBytes: view}));
    assert.equal(terminalReplaySnapshot().bytes, buffer.byteLength);
    registerTerminalSink(id, {writeEntry: (item) => replayed.push(item.dataBytes!)});
    assert.deepEqual(replayed, views);
    assert.ok(replayed.every((view, index) => view === views[index]));
  } finally { forgetTerminalDirect(id); }
  assert.equal(terminalReplaySnapshot().bytes, 0);
});
