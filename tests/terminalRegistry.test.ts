import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTerminalDirect,
  forgetTerminalDirect,
  registerTerminalSink,
  writeTerminalEntryDirect,
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
        dataBase64: "AA==",
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
