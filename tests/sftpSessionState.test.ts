import assert from "node:assert/strict";
import test from "node:test";
import { planSftpInitialization } from "../src/app/sftpSessionState";

type Candidate = Parameters<typeof planSftpInitialization>[0][number];

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "session-a",
    state: "connected",
    connectionId: "connection-a",
    terminalId: "terminal-a",
    sftpId: null,
    ...overrides,
  };
}

test("connected sessions with an SFTP id never schedule another open", () => {
  const sessions = [
    candidate({ id: "session-a", connectionId: "connection-a", sftpId: "sftp-a" }),
    candidate({ id: "session-b", connectionId: "connection-b", terminalId: "terminal-b", sftpId: "sftp-b" }),
  ];

  assert.deepEqual(planSftpInitialization(sessions, new Set()).targets, []);
  assert.deepEqual(planSftpInitialization([...sessions].reverse(), new Set()).targets, []);
});

test("all connected terminal sessions initialize independently of the active tab", () => {
  const sessions = [
    candidate({ id: "session-a", connectionId: "connection-a", terminalId: "terminal-a" }),
    candidate({ id: "session-b", connectionId: "connection-b", terminalId: "terminal-b" }),
  ];

  assert.deepEqual(
    planSftpInitialization(sessions, new Set()).targets.map((target) => target.connectionKey),
    ["session-a:connection-a", "session-b:connection-b"],
  );
});

test("a connection is initialized once and only a changed connection id is eligible again", () => {
  const session = candidate();
  const first = planSftpInitialization([session], new Set());
  assert.deepEqual(first.targets, [{
    sessionId: "session-a",
    connectionId: "connection-a",
    connectionKey: "session-a:connection-a",
  }]);

  const attempted = new Set([first.targets[0].connectionKey]);
  assert.deepEqual(planSftpInitialization([session], attempted).targets, []);

  const reconnected = candidate({ connectionId: "connection-b" });
  assert.deepEqual(
    planSftpInitialization([reconnected], attempted).targets.map((target) => target.connectionKey),
    ["session-a:connection-b"],
  );
});

test("closed connections are removed from the live key set", () => {
  const plan = planSftpInitialization([
    candidate({ connectionId: null, terminalId: null, state: "disconnected" }),
  ], new Set(["session-a:connection-a"]));

  assert.equal(plan.liveConnectionKeys.size, 0);
  assert.equal(plan.targets.length, 0);
});
