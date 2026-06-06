import type { TerminalEntry } from "../types";

export type TerminalSink = {
  writeEntry: (entry: TerminalEntry) => void;
  clear?: () => void;
  reset?: () => void;
};

const sinks = new Map<string, TerminalSink>();
const pendingEntries = new Map<string, TerminalEntry[]>();

export function registerTerminalSink(terminalId: string, sink: TerminalSink) {
  sinks.set(terminalId, sink);
  flushPendingTerminalEntries(terminalId);
  return () => {
    if (sinks.get(terminalId) === sink) {
      sinks.delete(terminalId);
    }
  };
}

export function writeTerminalEntryDirect(terminalId: string, entry: TerminalEntry) {
  const sink = sinks.get(terminalId);
  if (sink) {
    sink.writeEntry(entry);
    return true;
  }

  const pending = pendingEntries.get(terminalId) ?? [];
  pendingEntries.set(terminalId, appendPendingEntry(pending, entry));
  return false;
}

export function clearTerminalDirect(terminalId: string) {
  pendingEntries.delete(terminalId);
  sinks.get(terminalId)?.clear?.();
}

export function resetTerminalDirect(terminalId: string) {
  pendingEntries.delete(terminalId);
  sinks.get(terminalId)?.reset?.();
}

export function forgetTerminalDirect(terminalId: string) {
  pendingEntries.delete(terminalId);
  sinks.delete(terminalId);
}

export function clearAllTerminalDirect() {
  pendingEntries.clear();
  sinks.clear();
}

function flushPendingTerminalEntries(terminalId: string) {
  const sink = sinks.get(terminalId);
  if (!sink) return;
  const pending = pendingEntries.get(terminalId);
  if (!pending?.length) return;
  pendingEntries.delete(terminalId);
  for (const entry of pending) {
    sink.writeEntry(entry);
  }
}

function appendPendingEntry(entries: TerminalEntry[], entry: TerminalEntry) {
  const last = entries[entries.length - 1];
  if (last && entry.kind === "output" && last.kind === "output" && !last.dataBase64 && !entry.dataBase64) {
    return [
      ...entries.slice(0, -1),
      {
        ...last,
        content: `${last.content}${entry.content}`,
      },
    ];
  }
  if (last && entry.kind !== "output" && last.kind === entry.kind && last.content === entry.content) {
    return entries;
  }
  return [...entries, entry];
}
