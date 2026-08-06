import type { TerminalEntry } from "../types";

export type TerminalSink = {
  writeEntry: (entry: TerminalEntry) => void;
  clear?: () => void;
  reset?: () => void;
};

const sinks = new Map<string, TerminalSink>();
const replayEntries = new Map<string, TerminalReplayBuffer>();

type TerminalReplayBuffer = {
  entries: TerminalEntry[];
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

export function writeTerminalEntryDirect(terminalId: string, entry: TerminalEntry) {
  appendTerminalReplayEntry(terminalId, entry);
  const sink = sinks.get(terminalId);
  if (sink) {
    sink.writeEntry(entry);
    return true;
  }
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
  for (const entry of replay.entries) {
    sink.writeEntry(entry);
  }
}

function appendTerminalReplayEntry(terminalId: string, entry: TerminalEntry) {
  const replay = replayEntries.get(terminalId) ?? { entries: [], bytes: 0 };
  const last = replay.entries[replay.entries.length - 1];
  if (!(last && entry.kind !== "output" && last.kind === entry.kind && last.content === entry.content)) {
    replay.entries.push(entry);
    replay.bytes += terminalEntryReplayBytes(entry);
  }

  while (
    replay.entries.length > 1 &&
    (replay.bytes > MAX_TERMINAL_REPLAY_BYTES || replay.entries.length > MAX_TERMINAL_REPLAY_ENTRIES)
  ) {
    const removed = replay.entries.shift();
    if (removed) replay.bytes -= terminalEntryReplayBytes(removed);
  }
  replayEntries.set(terminalId, replay);
}

function terminalEntryReplayBytes(entry: TerminalEntry) {
  return (entry.content.length + (entry.dataBase64?.length ?? 0)) * 2;
}
