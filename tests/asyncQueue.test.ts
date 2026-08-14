import assert from "node:assert/strict";
import test from "node:test";
import {
  createAsyncQueue,
  invalidateAsyncQueues,
  isAsyncQueueInvalidatedError,
} from "../src/lib/asyncQueue";

test("async queue executes mutations in submission order", async () => {
  const queue = createAsyncQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = queue.enqueue(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    return 1;
  });
  const second = queue.enqueue(async () => {
    events.push("second");
    return 2;
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("async queue continues after a failed mutation", async () => {
  const queue = createAsyncQueue();
  const failed = queue.enqueue(async () => { throw new Error("failed"); });
  const next = queue.enqueue(async () => "ok");

  await assert.rejects(failed, /failed/);
  assert.equal(await next, "ok");
});

test("invalidating a queue rejects tasks that have not started", async () => {
  const queue = createAsyncQueue();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = queue.enqueue(async () => firstGate);
  let secondStarted = false;
  const second = queue.enqueue(async () => {
    secondStarted = true;
  });

  await Promise.resolve();
  queue.invalidate();
  releaseFirst();
  await first;

  await assert.rejects(second, (error) => isAsyncQueueInvalidatedError(error));
  assert.equal(secondStarted, false);
});

test("new tasks can run after queue invalidation", async () => {
  const queue = createAsyncQueue();
  queue.invalidate();
  assert.equal(await queue.enqueue(async () => "latest"), "latest");
});

test("global invalidation rejects queued work across queues", async () => {
  const firstQueue = createAsyncQueue();
  const secondQueue = createAsyncQueue();
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const running = firstQueue.enqueue(async () => firstGate);
  const alsoRunning = secondQueue.enqueue(async () => secondGate);
  const stale = firstQueue.enqueue(async () => "stale");
  const alsoStale = secondQueue.enqueue(async () => "also stale");

  await Promise.resolve();
  invalidateAsyncQueues();
  releaseFirst();
  releaseSecond();
  await Promise.all([running, alsoRunning]);

  await assert.rejects(stale, (error) => isAsyncQueueInvalidatedError(error));
  await assert.rejects(alsoStale, (error) => isAsyncQueueInvalidatedError(error));
  assert.equal(await secondQueue.enqueue(async () => "fresh"), "fresh");
});
