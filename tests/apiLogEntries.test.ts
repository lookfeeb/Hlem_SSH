import assert from "node:assert/strict";
import test from "node:test";
import { mergeApiLogEntries } from "../src/lib/apiLogEntries";

function log(timestamp: string, detail: string) {
  return { timestamp, action: "exec", detail, success: true, durationMs: 1 };
}

test("API log initial load preserves events received while the request was in flight", () => {
  assert.deepEqual(
    mergeApiLogEntries([log("2026-01-01T00:00:02Z", "event")], [log("2026-01-01T00:00:01Z", "loaded")]),
    [log("2026-01-01T00:00:01Z", "loaded"), log("2026-01-01T00:00:02Z", "event")],
  );
});

test("API log merging deduplicates entries and keeps the newest bounded tail", () => {
  const entries = [log("2026-01-01T00:00:01Z", "one"), log("2026-01-01T00:00:02Z", "two")];
  assert.deepEqual(mergeApiLogEntries(entries, [entries[1]], 1), [entries[1]]);
});
