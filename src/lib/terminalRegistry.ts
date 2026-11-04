import type { TerminalEntry } from "../types";

export type TerminalSink = {
  writeEntry: (entry: TerminalEntry, onConsumed?: () => void) => void;
  clear?: () => void;
  reset?: () => void;
};

const sinks = new Map<string, TerminalSink>();
const replayEntries = new Map<string, TerminalReplayBuffer>();

type TerminalReplayBuffer = {
  entries: Array<TerminalEntry | undefined>;
  head: number;
  bytes: number;
  buffers: Map<ArrayBufferLike, number>;
};

const MAX_TERMINAL_REPLAY_BYTES = 4 * 1024 * 1024;
const MAX_TERMINAL_REPLAY_ENTRIES = 4096;
const MAX_TOTAL_REPLAY_BYTES = 16 * 1024 * 1024;
const MAX_REPLAY_TERMINALS = 32;
let totalReplayBytes = 0;

function removeReplay(terminalId: string) {
  const replay = replayEntries.get(terminalId);
  if (replay) totalReplayBytes -= replay.bytes;
  replayEntries.delete(terminalId);
}

export function terminalReplaySnapshot() {
  return { terminals: replayEntries.size, bytes: totalReplayBytes, maxBytes: MAX_TOTAL_REPLAY_BYTES };
}

export function registerTerminalSink(terminalId: string, sink: TerminalSink) {
  sinks.set(terminalId, sink);
  replayTerminalEntries(terminalId, sink);
  return () => {
    if (sinks.get(terminalId) === sink) {
      sinks.delete(terminalId);
    }
  };
}

export function writeTerminalEntryDirect(terminalId: string, entry: TerminalEntry, onConsumed?: () => void) {
  appendTerminalReplayEntry(terminalId, entry);
  const sink = sinks.get(terminalId);
  if (sink) {
    sink.writeEntry(entry, onConsumed);
    return true;
  }
  onConsumed?.();
  return false;
}

export function clearTerminalDirect(terminalId: string) {
  removeReplay(terminalId);
  sinks.get(terminalId)?.clear?.();
}

export function forgetTerminalDirect(terminalId: string) {
  removeReplay(terminalId);
  sinks.delete(terminalId);
}

export function clearAllTerminalDirect() {
  replayEntries.clear();
  totalReplayBytes = 0;
  sinks.clear();
}

function replayTerminalEntries(terminalId: string, sink: TerminalSink) {
  const replay = replayEntries.get(terminalId);
  if (!replay?.entries.length) return;
  for (let index = replay.head; index < replay.entries.length; index += 1) {
    const entry = replay.entries[index];
    if (entry) sink.writeEntry(entry);
  }
}

function appendTerminalReplayEntry(terminalId: string, entry: TerminalEntry) {
  // Native frames are <=64 KiB. Do not retain an oversized foreign backing
  // store through a tiny view; live delivery and consumption still proceed.
  if (terminalEntryReplayBytes(entry) > MAX_TERMINAL_REPLAY_BYTES) {
    removeReplay(terminalId);
    return;
  }
  const replay = replayEntries.get(terminalId) ?? { entries: [], head: 0, bytes: 0, buffers: new Map<ArrayBufferLike, number>() };
  const previousBytes = replay.bytes;
  const last = replay.entries[replay.entries.length - 1];
  if (!(last && !entry.dataBytes && entry.kind !== "output" && last.kind === entry.kind && last.content === entry.content)) {
    replay.entries.push(entry);
    replay.bytes += entry.content.length * 2;
    const buffer = entry.dataBytes?.buffer;
    if (buffer) {
      const references = replay.buffers.get(buffer) ?? 0;
      if (!references) replay.bytes += buffer.byteLength;
      replay.buffers.set(buffer, references + 1);
    }
  }

  while (
    replay.entries.length - replay.head > 1 &&
    (replay.bytes > MAX_TERMINAL_REPLAY_BYTES || replay.entries.length - replay.head > MAX_TERMINAL_REPLAY_ENTRIES)
  ) {
    const removed = replay.entries[replay.head];
    replay.entries[replay.head++] = undefined;
    if (removed) {
      replay.bytes -= removed.content.length * 2;
      const buffer = removed.dataBytes?.buffer;
      if (buffer) {
        const references = replay.buffers.get(buffer)! - 1;
        if (references) replay.buffers.set(buffer, references);
        else { replay.buffers.delete(buffer); replay.bytes -= buffer.byteLength; }
      }
    }
  }
  if (replay.head >= MAX_TERMINAL_REPLAY_ENTRIES) {
    replay.entries = replay.entries.slice(replay.head);
    replay.head = 0;
  }
  totalReplayBytes += replay.bytes - previousBytes;
  replayEntries.delete(terminalId);
  replayEntries.set(terminalId, replay);
  while (totalReplayBytes > MAX_TOTAL_REPLAY_BYTES || replayEntries.size > MAX_REPLAY_TERMINALS) {
    removeReplay(replayEntries.keys().next().value!);
  }
}

function terminalEntryReplayBytes(entry: TerminalEntry) {
  return entry.content.length * 2 + (entry.dataBytes?.buffer.byteLength ?? 0);
}
