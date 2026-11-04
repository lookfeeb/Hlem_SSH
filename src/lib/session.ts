import type { TerminalEntry } from "../types";
import type { RemoteSession } from "../types";

export function createTerminalEntry(kind: TerminalEntry["kind"], content: string): TerminalEntry {
  return {
    id: crypto.randomUUID(),
    kind,
    content,
    timestamp: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  };
}

let terminalOutputSequence = 0;

/** Stream chunks have no visible timestamp; keep bytes and avoid locale/UUID work. */
export function createTerminalOutputEntry(kind: TerminalEntry["kind"], dataBytes: Uint8Array, hasBareCarriageReturn?: boolean): TerminalEntry {
  return { id: `stream-${++terminalOutputSequence}`, kind, content: "", dataBytes, timestamp: "", hasBareCarriageReturn };
}

export function remoteSessionConfigId(session: Pick<RemoteSession, "id" | "configId">): string {
  return session.configId || session.id;
}

export function isRuntimeSession(session: Pick<RemoteSession, "id" | "configId">): boolean {
  return remoteSessionConfigId(session) !== session.id;
}
