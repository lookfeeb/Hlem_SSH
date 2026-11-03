import assert from "node:assert/strict";
import test from "node:test";
import { apiLogCommand, apiLogResponseNotices, decodePowerShellOutput, extractApiLogOutputs, filterApiLogEntries, formatApiLogDecodedResponse, formatApiLogReadableResponse, formatApiLogResponse, mergeApiLogEntries } from "../src/lib/apiLogEntries";

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
  for (const response of ['{"output":5}', '{"output":"truncated...', "plain\\ntext"]) {
    assert.deepEqual(extractApiLogOutputs(response), []);
  }
});

test("QEMU Base64 and Chinese PowerShell errors are readable, with separate guest exit status", () => {
  const xml = '#< CLIXML\r\n<Objs><S S="Error">连接 127.0.0.1:19108 被拒绝_x000D__x000A_</S><S S="Error">A &amp; B &lt; C_x000D__x000A_</S></Objs>';
  const guest = { return: { exitcode: 1, "err-data": Buffer.from(xml).toString("base64"), "err-truncated": false, exited: true } };
  for (const response of [JSON.stringify(guest), JSON.stringify({ logFormat: "exec-v1", stdout: JSON.stringify(guest), stderr: "", exitStatus: 0, timedOut: false })]) {
    const readable = formatApiLogDecodedResponse(response);
    assert.ok(readable.includes("退出码: 1"));
    assert.ok(readable.includes("连接 127.0.0.1:19108 被拒绝\r\nA & B < C"));
    assert.ok(!readable.includes("CLIXML"));
    assert.ok(!readable.includes(guest.return["err-data"]));
  }
});

test("Base64 decoding is limited to explicit output fields and preserves binary or invalid input", () => {
  assert.equal(extractApiLogOutputs('{"return":{"out-data":"YWJj"}}')[0].text, "abc");
  for (const payload of ["not-base64", "YWJ", "AP8=", "/w=="]) {
    const result = extractApiLogOutputs(JSON.stringify({ return: { "out-data": payload } }));
    assert.equal(result[0].text, payload);
    assert.ok(result[0].label.includes("原始 Base64"));
  }
  assert.equal(extractApiLogOutputs('{"stdout":"YWJj"}')[0].text, "YWJj");
});

test("CLIXML decodes XML and PowerShell escapes once and never resolves external entities", () => {
  assert.equal(decodePowerShellOutput('#< CLIXML\n<Objs><S>_x005F_x000D_ &amp;lt; &#x4e2d;</S></Objs>'), "_x000D_ &lt; 中");
  const unsafe = '#< CLIXML\n<!DOCTYPE x [<!ENTITY external SYSTEM "file:///private">]><Objs><S>&external;</S></Objs>';
  assert.equal(decodePowerShellOutput(unsafe), unsafe);
  assert.equal(decodePowerShellOutput("plain _x000A_"), "plain _x000A_");
});

test("structured source output expands actual newlines, preserves source escapes and numeric precision", () => {
  const source = "import socket\nheader='\\r\\n'\n" + "print('中文')\n".repeat(500);
  const response = '{"pid":9223372036854775807,"source":' + JSON.stringify(source) + '}';
  const readable = formatApiLogReadableResponse(response);
  assert.ok(readable.includes('"pid": 9223372036854775807'));
  assert.ok(readable.includes("import socket\n    header='\\r\\n'\n"));
  assert.ok(readable.includes("print('中文')"));
  assert.ok(formatApiLogDecodedResponse(JSON.stringify({ stdout: response })).includes(readable));
});

test("execution envelopes expose full commands, stderr, truncation and legacy fallback", () => {
  const response = JSON.stringify({ logFormat: "exec-v1", command: "python3 - <<'PY'\nprint(1)\nPY", stdout: "partial", stderr: "failed", exitStatus: 1, timedOut: true, stdoutTruncated: true, outputTruncated: true });
  assert.equal(apiLogCommand({ ...log("1", "python3..."), response }), "python3 - <<'PY'\nprint(1)\nPY");
  assert.equal(apiLogCommand(log("1", "legacy")), "legacy");
  const readable = formatApiLogDecodedResponse(response);
  assert.ok(readable.includes("failed"));
  assert.ok(readable.includes("超时: 是"));
  assert.equal(apiLogResponseNotices(response).length, 2);
  assert.equal(apiLogResponseNotices('{"pid":1,"source":"cut').length, 1);
  assert.equal(apiLogResponseNotices(JSON.stringify({ stdout: JSON.stringify({ return: { "err-truncated": true } }) })).length, 1);
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
