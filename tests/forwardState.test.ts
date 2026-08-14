import assert from "node:assert/strict";
import test from "node:test";
import { applyForwardStatus, normalizeForwardList } from "../src/lib/forwardState";
import type { ForwardInfo } from "../src/types";

function forward(overrides: Partial<ForwardInfo> = {}): ForwardInfo {
  return {
    forwardId: "forward-a",
    tunnelId: "tunnel-a",
    sessionId: "session-a",
    forwardType: "local",
    bindHost: "127.0.0.1",
    bindPort: 8080,
    targetHost: "127.0.0.1",
    targetPort: 80,
    status: "running",
    startedAt: "2026-08-13T00:00:00.000Z",
    error: null,
    ...overrides,
  };
}

test("terminal forward events remove the matching runtime record", () => {
  const current = [forward(), forward({ forwardId: "forward-b" })];
  const canceled = forward({ status: "canceled" });

  assert.deepEqual(applyForwardStatus(current, canceled).map((item) => item.forwardId), ["forward-b"]);
});

test("forward status updates replace a record without duplicating it", () => {
  const failed = forward({ status: "failed", error: "listener closed" });
  const next = applyForwardStatus([forward()], failed);

  assert.equal(next.length, 1);
  assert.equal(next[0].status, "failed");
});

test("forward snapshots use deterministic newest-first ordering", () => {
  const items = normalizeForwardList([
    forward({ forwardId: "old", startedAt: "2026-08-12T00:00:00.000Z" }),
    forward({ forwardId: "new", startedAt: "2026-08-13T00:00:00.000Z" }),
  ]);

  assert.deepEqual(items.map((item) => item.forwardId), ["new", "old"]);
});
