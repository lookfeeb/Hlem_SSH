import assert from "node:assert/strict";
import test from "node:test";
import { buildAiApiSessionCommand } from "../src/lib/aiApiCommand.ts";

test("copies the API URL and authorization on separate lines before the clicked host identity", () => {
  const text = buildAiApiSessionCommand({ port: 23456, apiKey: "helm_test_key" }, {
    id: "host-b", name: "GCP 香港", host: "192.0.2.2",
  });
  assert.deepEqual(text.split("\n"), [
    '"http://127.0.0.1:23456/api/fields"',
    'curl -H "Authorization: Bearer helm_test_key"',
    "",
    "会话ID: host-b",
    "会话主机: GCP 香港 192.0.2.2",
  ]);
});

test("uses current credentials independently for different hosts", () => {
  const first = buildAiApiSessionCommand({ port: 19880, apiKey: "helm_old_key" }, { id: "a", name: "A", host: "192.0.2.1" });
  const second = buildAiApiSessionCommand({ port: 19881, apiKey: "helm_new_key" }, { id: "b", name: "B", host: "192.0.2.2" });
  assert.ok(first.includes("会话ID: a"));
  assert.ok(second.includes("会话ID: b"));
  assert.ok(second.includes("helm_new_key"));
  assert.ok(second.includes(":19881/api/fields"));
  assert.ok(!second.includes("helm_old_key"));
});
