import assert from "node:assert/strict";
import test from "node:test";
import { extractApiLogOutputs, filterApiLogEntries, formatApiLogResponse, mergeApiLogEntries } from "../src/lib/apiLogEntries";

function log(timestamp: string, detail: string) {
  return { timestamp, action: "exec", detail, success: true, durationMs: 1 };
}

test("API log text view decodes JSON newlines once and preserves literal backslashes", () => {
  const output = '服务运行正常\n任务已完成\r\nC:\\new\\notes.txt\nliteral \\n stays literal';
  const response = JSON.stringify({ return: { output, exitcode: 0 } });
  assert.deepEqual(extractApiLogOutputs(response), [{ label: "文本输出 · return.output", text: output }]);
  assert.ok(formatApiLogResponse(response).includes('正常\\n任务'));
  assert.equal(extractApiLogOutputs(response)[0].text.split("\n").length, 4);
});

test("API log text view keeps stdout and stderr separate and ignores non-text payloads", () => {
  assert.deepEqual(extractApiLogOutputs('{"stdout":"ok\\n","stderr":"error\\n"}'), [
    { label: "标准输出", text: "ok\n" }, { label: "错误输出", text: "error\n" },
  ]);
  for (const response of ['{"output":5}', '{"return":{"out-data":"YWJj"}}', '{"output":"truncated...', "plain\\ntext"]) {
    assert.deepEqual(extractApiLogOutputs(response), []);
  }
});

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

test("API log search combines response, status and exact operation filters without changing source order", () => {
  const entries = [
    { ...log("1", "echo ready"), action: "rest/exec", response: "READY" },
    { ...log("2", "echo ready"), action: "rest/exec", success: false, response: "Permission denied" },
    { ...log("3", "download"), action: "rest/download", success: false, response: "Permission denied" },
  ];
  assert.deepEqual(filterApiLogEntries(entries, " PERMISSION ", "error", "rest/exec"), [entries[1]]);
  assert.deepEqual(filterApiLogEntries(entries, "成功", "all", ""), [entries[0]]);
  assert.deepEqual(filterApiLogEntries(entries, "", "all", ""), entries);
  assert.equal(entries[0].timestamp, "1");
});

test("API log response formatting preserves large integers, escaped text and empty containers", () => {
  const source = '{"id":9223372036854775807,"text":"a, b: \\"value\\"","empty":[],"nested":{"ok":true}}';
  const formatted = formatApiLogResponse(source);
  assert.ok(formatted.includes("9223372036854775807"));
  assert.ok(formatted.includes('"text": "a, b: \\"value\\""'));
  assert.ok(formatted.includes('"empty": []'));
  assert.deepEqual(JSON.parse(formatted), JSON.parse(source));
  assert.ok(formatted.includes('\n  "nested": {\n    "ok": true\n  }'));
});

test("API log response formatting preserves plain, truncated and excessively nested output", () => {
  for (const source of ["", " permission denied\n", '{"return":{"data":"truncated...', '<script>alert("output")</script>', "[".repeat(100) + "0" + "]".repeat(100)]) {
    assert.equal(formatApiLogResponse(source), source);
  }
});
