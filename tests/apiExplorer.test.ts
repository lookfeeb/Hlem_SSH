import assert from "node:assert/strict";
import test from "node:test";
import {
  buildApiExplorerRequest,
  buildCurlCommand,
  consumeApiSseChunk,
  createRequestDefaults,
  formatApiResponseForClipboard,
  formatApiResponseForDisplay,
  listOpenApiEndpoints,
  type OpenApiDocument,
} from "../src/lib/apiExplorer";

const document: OpenApiDocument = {
  openapi: "3.1.0",
  paths: {
    "/api/exec": {
      post: {
        tags: ["命令"],
        summary: "执行命令",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ExecBody" },
            },
          },
        },
      },
    },
    "/api/files": {
      get: {
        tags: ["文件"],
        parameters: [
          { name: "sessionId", in: "query", required: true, schema: { type: "string" } },
          { name: "path", in: "query", required: true, schema: { type: "string" } },
        ],
      },
    },
    "/api/tunnels/{id}": {
      patch: {
        tags: ["隧道"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TunnelPatch" },
            },
          },
        },
      },
    },
    "/api/jobs/{job_id}/events": {
      get: {
        tags: ["长任务"],
        parameters: [
          { name: "job_id", in: "path", required: true, schema: { type: "string" } },
          { name: "Last-Event-ID", in: "header", schema: { type: "number" } },
        ],
      },
    },
  },
  components: {
    schemas: {
      ExecBody: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          command: { type: "string" },
          timeoutMs: { type: "number", default: 300_000, minimum: 1, maximum: 300_000 },
        },
      },
      TunnelPatch: {
        type: "object",
        properties: {
          name: { type: "string", example: "SSH Tunnel Updated" },
          bindPort: { type: "number", minimum: 0, maximum: 65535 },
        },
      },
    },
  },
};

test("OpenAPI endpoints are flattened and request defaults use the selected session", () => {
  const endpoints = listOpenApiEndpoints(document);
  const exec = endpoints.find((item) => item.path === "/api/exec")!;
  const files = endpoints.find((item) => item.path === "/api/files")!;
  assert.deepEqual(createRequestDefaults(document, exec, "session-a").body, {
    sessionId: "session-a",
    command: "uname -a",
    timeoutMs: 300_000,
  });
  assert.deepEqual(createRequestDefaults(document, files, "session-b").query, {
    sessionId: "session-b",
    path: "/",
  });
});

test("PATCH defaults contain one meaningful change instead of a full replacement body", () => {
  const endpoint = listOpenApiEndpoints(document).find((item) => item.method === "patch")!;
  assert.deepEqual(createRequestDefaults(document, endpoint).body, {
    name: "SSH Tunnel Updated",
  });
});

test("request plans encode query values and copied curl commands retain JSON bodies", () => {
  const endpoint = listOpenApiEndpoints(document).find((item) => item.path === "/api/files")!;
  const plan = buildApiExplorerRequest(
    "http://127.0.0.1:19880",
    endpoint,
    {},
    { sessionId: "a b", path: "/var/log" },
    null,
    null,
  );
  assert.equal(plan.url, "http://127.0.0.1:19880/api/files?sessionId=a+b&path=%2Fvar%2Flog");

  const post = listOpenApiEndpoints(document).find((item) => item.path === "/api/exec")!;
  const postPlan = buildApiExplorerRequest(
    "http://127.0.0.1:19880",
    post,
    {},
    {},
    { sessionId: "session-a", command: "echo 'ok'" },
    "application/json",
  );
  const command = buildCurlCommand(postPlan, "secret");
  assert.match(command, /Authorization: Bearer secret/);
  assert.match(command, /echo ''ok''/);

  const events = listOpenApiEndpoints(document).find((item) => item.path.endsWith("/events"))!;
  assert.deepEqual(createRequestDefaults(document, events).query, {});
  const streamPlan = buildApiExplorerRequest(
    "http://127.0.0.1:19880",
    events,
    { job_id: "job_123" },
    {},
    null,
    null,
  );
  const streamCommand = buildCurlCommand(streamPlan, "secret");
  assert.match(streamCommand, /curl\.exe -N -X GET/);
  assert.match(streamCommand, /Accept: text\/event-stream/);
});

test("response copy formats JSON structures and preserves plain text", () => {
  assert.equal(
    formatApiResponseForClipboard('[{"status":"success","size":9851}]'),
    '[\n  {\n    "status": "success",\n    "size": 9851\n  }\n]',
  );
  assert.equal(formatApiResponseForClipboard("plain response\nline 2"), "plain response\nline 2");
});

test("response display pretty prints JSON and assigns semantic token colors", () => {
  const display = formatApiResponseForDisplay('{"name":"HelM","count":2,"ready":true,"error":null}');
  assert.equal(display.kind, "json");
  assert.equal(display.text, '{\n  "name": "HelM",\n  "count": 2,\n  "ready": true,\n  "error": null\n}');
  assert.deepEqual(
    [...new Set(display.tokens.filter((token) => token.type !== "plain").map((token) => token.type))].sort(),
    ["boolean", "key", "null", "number", "punctuation", "string"],
  );

  const plain = formatApiResponseForDisplay("stdout line\nstderr line");
  assert.equal(plain.kind, "text");
  assert.deepEqual(plain.tokens, [{ type: "plain", value: "stdout line\nstderr line" }]);
});

test("SSE parser supports split chunks, JSON data, multiline text and keepalive frames", () => {
  const first = consumeApiSseChunk("", ': keepalive\r\nid: 1\r\nevent: stdout\r\ndata: {"payload":{"text":"hel');
  assert.deepEqual(first.events, []);

  const second = consumeApiSseChunk(first.buffer, 'lo"}}\r\n\r\nevent: log\ndata: first\ndata: second\n\n');
  assert.equal(second.buffer, "");
  assert.deepEqual(second.events, [
    { id: "1", event: "stdout", data: { payload: { text: "hello" } } },
    { event: "log", data: "first\nsecond" },
  ]);
});

test("SSE parser can flush a final unterminated event and ignores comments without data", () => {
  const result = consumeApiSseChunk("", ": ping\n\nid: 9\nevent: completed\ndata: {}", true);
  assert.equal(result.buffer, "");
  assert.deepEqual(result.events, [{ id: "9", event: "completed", data: {} }]);
});
