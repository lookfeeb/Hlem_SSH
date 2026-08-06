import assert from "node:assert/strict";
import test from "node:test";
import { mergeTransferInfo } from "../src/lib/transferRecords";
import type { TransferInfo } from "../src/types";

function transfer(overrides: Partial<TransferInfo> = {}): TransferInfo {
  return {
    transferId: "transfer-a",
    sessionId: "session-a",
    sftpId: "sftp-a",
    direction: "download",
    localPath: "C:/tmp/file.txt",
    remotePath: "/tmp/file.txt",
    status: "queued",
    bytesDone: 0,
    bytesTotal: 227,
    speedKbps: 0,
    error: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

test("a late invoke result cannot revive a completed tiny transfer", () => {
  const completed = transfer({
    status: "completed",
    bytesDone: 227,
    updatedAt: "2026-08-01T00:00:00.001Z",
  });
  const queuedInvokeResult = transfer();

  assert.equal(mergeTransferInfo(completed, queuedInvokeResult), completed);
});

test("equal-time snapshots cannot regress progress or status", () => {
  const running = transfer({ status: "running", bytesDone: 128 });

  assert.equal(mergeTransferInfo(running, transfer()), running);
});

test("a genuinely newer active snapshot is accepted", () => {
  const paused = transfer({ status: "paused", updatedAt: "2026-08-01T00:00:01.000Z" });

  assert.equal(mergeTransferInfo(transfer({ status: "running" }), paused), paused);
});
