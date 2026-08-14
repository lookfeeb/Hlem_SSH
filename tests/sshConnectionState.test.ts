import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPendingUiConnectionForConfig,
  shouldApplySshStatusToSession,
} from "../src/lib/sshConnectionState";
import { createEmptyTelemetry } from "../src/lib/remoteDefaults";
import type { RemoteSession } from "../src/types";

function session(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: "session-a",
    name: "node",
    host: "127.0.0.1",
    username: "root",
    state: "connected",
    accent: "blue",
    favorite: false,
    currentPath: "/",
    connectionId: "connection-new",
    terminal: [],
    telemetry: createEmptyTelemetry("127.0.0.1"),
    filesPath: null,
    files: [],
    ...overrides,
  };
}

test("an old disconnect event cannot clear a newer connection of the same config", () => {
  assert.equal(shouldApplySshStatusToSession(
    session(),
    { connectionId: "connection-old", sessionId: "session-a", status: "disconnected" },
    false,
  ), false);
});

test("an exact connection event still applies", () => {
  assert.equal(shouldApplySshStatusToSession(
    session(),
    { connectionId: "connection-new", sessionId: "session-a", status: "disconnected" },
    false,
  ), true);
});

test("an external connected event can claim an idle base session", () => {
  assert.equal(shouldApplySshStatusToSession(
    session({ state: "disconnected", connectionId: null }),
    { connectionId: "connection-new", sessionId: "session-a", status: "connected" },
    false,
  ), true);
});

test("a connected event for a second UI-created runtime is not treated as external", () => {
  const base = session({ connectionId: null, state: "disconnected" });
  const existing = session({
    id: "runtime-existing",
    configId: "session-a",
    connectionId: "connection-existing",
  });
  const connecting = session({
    id: "runtime-connecting",
    configId: "session-a",
    connectionId: null,
    state: "connecting",
  });

  assert.equal(hasPendingUiConnectionForConfig(
    [base, existing, connecting],
    "session-a",
    new Set(["runtime-connecting"]),
  ), true);
});
