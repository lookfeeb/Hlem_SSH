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
};

const MAX_TERMINAL_REPLAY_BYTES = 4 * 1024 * 1024;
const MAX_TERMINAL_REPLAY_ENTRIES = 4096;

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
  replayEntries.delete(terminalId);
  sinks.get(terminalId)?.clear?.();
}

export function forgetTerminalDirect(terminalId: string) {
  replayEntries.delete(terminalId);
  sinks.delete(terminalId);
}

export function clearAllTerminalDirect() {
  replayEntries.clear();
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
  const replay = replayEntries.get(terminalId) ?? { entries: [], head: 0, bytes: 0 };
  const last = replay.entries[replay.entries.length - 1];
  if (!(last && !entry.dataBytes && entry.kind !== "output" && last.kind === entry.kind && last.content === entry.content)) {
    replay.entries.push(entry);
    replay.bytes += terminalEntryReplayBytes(entry);
  }

  while (
    replay.entries.length - replay.head > 1 &&
    (replay.bytes > MAX_TERMINAL_REPLAY_BYTES || replay.entries.length - replay.head > MAX_TERMINAL_REPLAY_ENTRIES)
  ) {
    const removed = replay.entries[replay.head];
    replay.entries[replay.head++] = undefined;
    if (removed) replay.bytes -= terminalEntryReplayBytes(removed);
  }
  if (replay.head >= MAX_TERMINAL_REPLAY_ENTRIES) {
    replay.entries = replay.entries.slice(replay.head);
    replay.head = 0;
  }
  replayEntries.set(terminalId, replay);
}

function terminalEntryReplayBytes(entry: TerminalEntry) {
  return entry.content.length * 2 + (entry.dataBytes?.byteLength ?? 0);
}
