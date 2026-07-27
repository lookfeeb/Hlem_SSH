import assert from "node:assert/strict";
import test from "node:test";
import {
  addConnectingSessionId,
  connectingSessionIdsFor,
  removeConnectingSessionIds,
} from "../src/app/sessionConnectionState";

test("the same session connection is claimed atomically", () => {
  const first = addConnectingSessionId(new Set(), "session-a");
  assert.deepEqual(first, new Set(["session-a"]));
  assert.equal(addConnectingSessionId(first!, "session-a"), null);
});

test("different sessions can connect and reconnect independently", () => {
  const first = addConnectingSessionId(new Set(), "session-a")!;
  const second = addConnectingSessionId(first, "session-b")!;
  assert.deepEqual(second, new Set(["session-a", "session-b"]));

  const remaining = removeConnectingSessionIds(second, ["session-a"]);
  assert.deepEqual(remaining, new Set(["session-b"]));
});

test("a config-level cancel resolves every connecting runtime instance", () => {
  const sessions = [
    { id: "config-a", configId: null },
    { id: "runtime-a", configId: "config-a" },
    { id: "runtime-b", configId: "config-a" },
    { id: "runtime-c", configId: "config-b" },
  ];
  const connecting = new Set(["runtime-a", "runtime-b", "runtime-c"]);

  assert.deepEqual(
    connectingSessionIdsFor("config-a", sessions, connecting),
    ["runtime-a", "runtime-b"],
  );
  assert.deepEqual(connectingSessionIdsFor("runtime-c", sessions, connecting), ["runtime-c"]);
});
