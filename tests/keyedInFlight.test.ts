import assert from "node:assert/strict";
import test from "node:test";
import { createKeyedInFlightCache, createLatestRequestTracker } from "../src/lib/keyedInFlight";

test("keyed in-flight cache coalesces concurrent requests", async () => {
  const cache = createKeyedInFlightCache<string, number>();
  let calls = 0;
  let release!: (value: number) => void;
  const gate = new Promise<number>((resolve) => { release = resolve; });

  const first = cache.run("directory", async () => {
    calls += 1;
    return gate;
  });
  const second = cache.run("directory", async () => {
    calls += 1;
    return 2;
  });

  assert.equal(first, second);
  release(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(calls, 1);
});

test("invalidating an in-flight request keeps its replacement cached", async () => {
  const cache = createKeyedInFlightCache<string, string>();
  let releaseOld!: (value: string) => void;
  let releaseFresh!: (value: string) => void;
  const oldGate = new Promise<string>((resolve) => { releaseOld = resolve; });
  const freshGate = new Promise<string>((resolve) => { releaseFresh = resolve; });

  const oldRequest = cache.run("directory", () => oldGate);
  cache.invalidate("directory");
  const freshRequest = cache.run("directory", () => freshGate);

  releaseOld("old");
  assert.equal(await oldRequest, "old");

  const reusedFreshRequest = cache.run("directory", async () => "unexpected");
  assert.equal(reusedFreshRequest, freshRequest);
  releaseFresh("fresh");
  assert.deepEqual(await Promise.all([freshRequest, reusedFreshRequest]), ["fresh", "fresh"]);
});

test("latest request tracker never reuses a version after invalidation or completion", () => {
  const tracker = createLatestRequestTracker<string>();
  const staleVersion = tracker.begin("directory");
  tracker.invalidate("directory");

  const replacementVersion = tracker.begin("directory");
  assert.notEqual(replacementVersion, staleVersion);
  assert.equal(tracker.isCurrent("directory", staleVersion), false);
  assert.equal(tracker.complete("directory", replacementVersion), true);

  const laterVersion = tracker.begin("directory");
  assert.notEqual(laterVersion, staleVersion);
  assert.equal(tracker.isCurrent("directory", staleVersion), false);
  assert.equal(tracker.isCurrent("directory", laterVersion), true);

  tracker.clear();
  const afterClearVersion = tracker.begin("directory");
  assert.notEqual(afterClearVersion, laterVersion);
  assert.equal(tracker.isCurrent("directory", laterVersion), false);
});
