export type ConnectingSessionCandidate = {
  id: string;
  configId?: string | null;
};

export function addConnectingSessionId(
  current: ReadonlySet<string>,
  sessionId: string,
): Set<string> | null {
  if (current.has(sessionId)) return null;
  const next = new Set(current);
  next.add(sessionId);
  return next;
}

export function removeConnectingSessionIds(
  current: ReadonlySet<string>,
  sessionIds: Iterable<string>,
): Set<string> {
  const next = new Set(current);
  for (const sessionId of sessionIds) next.delete(sessionId);
  return next;
}

export function connectingSessionIdsFor(
  requestedId: string,
  sessions: readonly ConnectingSessionCandidate[],
  connectingSessionIds: ReadonlySet<string>,
): string[] {
  if (connectingSessionIds.has(requestedId)) return [requestedId];
  return sessions
    .filter((session) =>
      connectingSessionIds.has(session.id) && (session.configId || session.id) === requestedId,
    )
    .map((session) => session.id);
}
