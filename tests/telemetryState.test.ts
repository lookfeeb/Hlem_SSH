import assert from "node:assert/strict";
import test from "node:test";
import { applyTelemetryEvent } from "../src/lib/telemetryState";
import { createEmptyTelemetry } from "../src/lib/remoteDefaults";
import type { RemoteSession, TelemetrySnapshotEvent } from "../src/types";

function session(): RemoteSession {
  return {
    id: "runtime-a",
    name: "node",
    host: "127.0.0.1",
    username: "root",
    state: "connected",
    accent: "blue",
    favorite: false,
    currentPath: "/",
    connectionId: "connection-new",
    telemetryJobId: "job-new",
    terminal: [],
    telemetry: { ...createEmptyTelemetry("127.0.0.1"), cpu: 42 },
    filesPath: null,
    files: [],
  };
}

function event(overrides: Partial<TelemetrySnapshotEvent> = {}): TelemetrySnapshotEvent {
  return {
    jobId: "job-new",
    connectionId: "connection-new",
    sessionId: "runtime-a",
    ...overrides,
  };
}

test("an old connection telemetry stop cannot clear the new connection state", () => {
  const current = session();
  const result = applyTelemetryEvent(current, event({
    jobId: "job-old",
    connectionId: "connection-old",
    terminal: true,
    error: "old connection closed",
  }));

  assert.strictEqual(result.session, current);
  assert.equal(result.terminal, false);
});

test("a terminal event for the active telemetry job clears stale metrics", () => {
  const result = applyTelemetryEvent(session(), event({ terminal: true, error: "stream closed" }));

  assert.equal(result.terminal, true);
  assert.equal(result.session.telemetryJobId, null);
  assert.equal(result.session.telemetry.cpu, 0);
});

test("a snapshot claims the matching job before the start invoke resolves", () => {
  const current = { ...session(), telemetryJobId: null };
  const snapshot = { ...createEmptyTelemetry("127.0.0.1"), cpu: 11 };
  const result = applyTelemetryEvent(current, event({ snapshot }));

  assert.equal(result.session.telemetryJobId, "job-new");
  assert.equal(result.session.telemetry.cpu, 11);
});
