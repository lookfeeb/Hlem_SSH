import assert from "node:assert/strict";
import test from "node:test";
import { loadStableSnapshot } from "../src/lib/stableSnapshot";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a snapshot query retries when an event arrives while it is in flight", async () => {
  let version = 0;
  const first = deferred<string[]>();
  const second = deferred<string[]>();
  const requests = [first, second];
  let requestCount = 0;
  const resultPromise = loadStableSnapshot(
    () => requests[requestCount++].promise,
    () => version,
    () => true,
  );

  version += 1;
  first.resolve(["stale-connection"]);
  await Promise.resolve();
  second.resolve([]);

  assert.deepEqual(await resultPromise, []);
  assert.equal(requestCount, 2);
});

test("an invalidated snapshot query cannot apply its late result", async () => {
  let current = true;
  const request = deferred<string[]>();
  const resultPromise = loadStableSnapshot(
    () => request.promise,
    () => 0,
    () => current,
  );

  current = false;
  request.resolve(["late-connection"]);

  assert.equal(await resultPromise, undefined);
});
