import type { RemoteSession } from "../types";

type SftpSessionCandidate = Pick<
  RemoteSession,
  "id" | "state" | "connectionId" | "terminalId" | "sftpId"
>;

export type SftpInitializationTarget = {
  sessionId: string;
  connectionId: string;
  connectionKey: string;
};

export function planSftpInitialization(
  sessions: readonly SftpSessionCandidate[],
  attemptedConnectionKeys: ReadonlySet<string>,
) {
  const liveConnectionKeys = new Set<string>();
  const targets: SftpInitializationTarget[] = [];

  for (const session of sessions) {
    if (!session.connectionId) continue;
    const connectionKey = `${session.id}:${session.connectionId}`;
    liveConnectionKeys.add(connectionKey);
    if (
      session.state !== "connected" ||
      !session.terminalId ||
      session.sftpId ||
      attemptedConnectionKeys.has(connectionKey)
    ) continue;
    targets.push({
      sessionId: session.id,
      connectionId: session.connectionId,
      connectionKey,
    });
  }

  return { liveConnectionKeys, targets };
}
