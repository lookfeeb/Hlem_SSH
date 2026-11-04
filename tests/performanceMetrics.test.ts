import assert from "node:assert/strict";
import test from "node:test";
import { performanceSnapshot, recordPerformance } from "../src/lib/performanceMetrics";

test("timing ring reports only its latest 128 samples after wrapping", (context) => {
  context.mock.method(performance, "now", () => 1000);
  for (let duration = 1; duration <= 256; duration++) {
    recordPerformance("ring-wrap", 1000 - duration, duration > 128 && duration !== 256);
  }
  assert.deepEqual(performanceSnapshot()["ring-wrap"], {
    samples: 128, errors: 1, p50Ms: 192, p95Ms: 250, maxMs: 256,
  });
});
