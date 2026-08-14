import assert from "node:assert/strict";
import test from "node:test";
import {
  canRemoveTransfer,
  applyFileSaveResult,
  beginFileSaveRetry,
  clearFinishedFileSaveRecords,
  mergeClearedTransferSnapshot,
  mergeTransferInfo,
  replaceRetriedTransfer,
} from "../src/lib/transferRecords";
import type { FileSaveRecord, TransferInfo } from "../src/types";

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

test("clearing old history preserves a transfer event received during the request", () => {
  const oldFinished = transfer({ transferId: "old", status: "completed", bytesDone: 227 });
  const lateRunning = transfer({ transferId: "new", status: "running", bytesDone: 1 });

  assert.deepEqual(mergeClearedTransferSnapshot([lateRunning, oldFinished], []), [lateRunning]);
});

test("a retry invoke result cannot duplicate or regress its completed event", () => {
  const old = transfer({ transferId: "old", status: "failed" });
  const completed = transfer({
    transferId: "new",
    status: "completed",
    bytesDone: 227,
    updatedAt: "2026-08-01T00:00:00.001Z",
  });
  const queuedResult = transfer({ transferId: "new" });

  const next = replaceRetriedTransfer([completed, old], "old", queuedResult);
  assert.deepEqual(next, [completed]);
});

test("clearing save history keeps writes that are still running", () => {
  const record = (id: string, status: FileSaveRecord["status"]): FileSaveRecord => ({
    id,
    attempt: 1,
    sessionId: "session-a",
    path: `/tmp/${id}.txt`,
    directory: "/tmp",
    name: `${id}.txt`,
    content: id,
    status,
    error: null,
    savedAt: "2026-08-01T00:00:00.000Z",
  });
  const saving = record("saving", "saving");

  assert.deepEqual(
    clearFinishedFileSaveRecords([
      record("success", "success"),
      saving,
      record("failed", "failed"),
    ]),
    [saving],
  );
});

test("duplicate save retries are ignored while an attempt is running", () => {
  const failed: FileSaveRecord = {
    id: "save-a",
    attempt: 1,
    sessionId: "session-a",
    path: "/tmp/a.txt",
    directory: "/tmp",
    name: "a.txt",
    content: "a",
    status: "failed",
    error: "failed",
    savedAt: "2026-08-01T00:00:00.000Z",
  };

  const first = beginFileSaveRetry([failed], failed.id, "2026-08-01T00:00:01.000Z");
  assert.equal(first.retry?.attempt, 2);
  const duplicate = beginFileSaveRetry(first.records, failed.id, "2026-08-01T00:00:02.000Z");
  assert.equal(duplicate.retry, null);
  assert.deepEqual(duplicate.records, first.records);
});

test("a late save attempt cannot overwrite a newer retry result", () => {
  const saving: FileSaveRecord = {
    id: "save-a",
    attempt: 2,
    sessionId: "session-a",
    path: "/tmp/a.txt",
    directory: "/tmp",
    name: "a.txt",
    content: "a",
    status: "saving",
    error: null,
    savedAt: "2026-08-01T00:00:01.000Z",
  };

  const stale = applyFileSaveResult([saving], saving.id, 1, {
    status: "failed",
    error: "old failure",
  });
  assert.deepEqual(stale, [saving]);

  const current = applyFileSaveResult([saving], saving.id, 2, {
    status: "success",
    error: null,
  });
  assert.equal(current[0].status, "success");
});

test("running transfers cannot be removed as if they were history records", () => {
  assert.equal(canRemoveTransfer(transfer({ status: "queued" })), false);
  assert.equal(canRemoveTransfer(transfer({ status: "running" })), false);
  assert.equal(canRemoveTransfer(transfer({ status: "paused" })), false);
  assert.equal(canRemoveTransfer(transfer({ status: "completed" })), true);
  assert.equal(canRemoveTransfer(transfer({ status: "failed" })), true);
  assert.equal(canRemoveTransfer(transfer({ status: "canceled" })), true);
});
