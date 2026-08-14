import { isRuntimeSession, remoteSessionConfigId } from "./session";
import type { RemoteSession } from "../types";

export function shouldApplySshStatusToSession(
  session: RemoteSession,
  payload: { connectionId: string; sessionId: string; status: RemoteSession["state"] },
  uiManaged: boolean,
): boolean {
  if (session.connectionId) return session.connectionId === payload.connectionId;
  if (isRuntimeSession(session) || session.id !== payload.sessionId) return false;
  if (payload.status === "disconnected") return false;
  return !uiManaged;
}

export function hasPendingUiConnectionForConfig(
  sessions: readonly RemoteSession[],
  configId: string,
  pendingSessionIds: ReadonlySet<string>,
): boolean {
  return sessions.some((session) => (
    pendingSessionIds.has(session.id) && remoteSessionConfigId(session) === configId
  ));
}
