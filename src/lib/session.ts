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

export function remoteSessionConfigId(session: Pick<RemoteSession, "id" | "configId">): string {
  return session.configId || session.id;
}

export function isRuntimeSession(session: Pick<RemoteSession, "id" | "configId">): boolean {
  return remoteSessionConfigId(session) !== session.id;
}
