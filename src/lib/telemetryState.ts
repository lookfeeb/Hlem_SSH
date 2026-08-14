import { createEmptyTelemetry } from "./remoteDefaults";
import type { RemoteSession, TelemetrySnapshotEvent } from "../types";

export type TelemetryEventResult = {
  session: RemoteSession;
  terminal: boolean;
};

export function applyTelemetryEvent(
  session: RemoteSession,
  payload: TelemetrySnapshotEvent,
): TelemetryEventResult {
  if (session.connectionId !== payload.connectionId) return { session, terminal: false };
  if (session.telemetryJobId && session.telemetryJobId !== payload.jobId) {
    return { session, terminal: false };
  }
  if (payload.snapshot) {
    return {
      terminal: false,
      session: {
        ...session,
        telemetryJobId: payload.jobId,
        telemetry: payload.snapshot,
      },
    };
  }
  if (!payload.terminal) return { session, terminal: false };
  return {
    terminal: true,
    session: {
      ...session,
      telemetryJobId: null,
      telemetry: createEmptyTelemetry(session.host),
    },
  };
}
