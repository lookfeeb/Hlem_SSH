import assert from "node:assert/strict";
import test from "node:test";
import { isConfigSnapshotCurrent } from "../src/lib/configSnapshot";
import type { ConfigSnapshot } from "../src/types";

function snapshot(revision: number): ConfigSnapshot {
  return { revision } as ConfigSnapshot;
}

test("config snapshot rejects an older async response", () => {
  assert.equal(isConfigSnapshotCurrent(snapshot(7), snapshot(6)), false);
});

test("config snapshot accepts the same or a newer revision", () => {
  assert.equal(isConfigSnapshotCurrent(snapshot(7), snapshot(7)), true);
  assert.equal(isConfigSnapshotCurrent(snapshot(7), snapshot(8)), true);
  assert.equal(isConfigSnapshotCurrent(undefined, snapshot(0)), true);
});
