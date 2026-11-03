import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { closeDetachedEditorChannel, createDetachedEditorChannel, getOrCreateDetachedEditorChannel, queueDetachedEditorTab } from "../src/lib/detachedEditorBridge";

const originalChannel = globalThis.BroadcastChannel;
class TestChannel {
  onmessage?: (event: { data: unknown }) => void;
  messages: unknown[] = [];
  closed = false;
  postMessage(message: unknown) { assert.ok(!this.closed); this.messages.push(message); }
  close() { this.closed = true; }
  receive(data: unknown) { this.onmessage?.({ data }); }
}
beforeEach(() => { globalThis.BroadcastChannel = TestChannel as unknown as typeof BroadcastChannel; });
afterEach(() => { closeDetachedEditorChannel(); globalThis.BroadcastChannel = originalChannel; });
const tab = { path: "/a.txt", content: "hello", sessionId: "s1", sessionName: "test", sessionHost: "localhost" };

test("editor tabs queued before readiness still arrive after the workspace loads lazily", () => {
  const channel = createDetachedEditorChannel(tab, async () => {});
  const fixture = channel as unknown as TestChannel;
  queueDetachedEditorTab(channel, { ...tab, path: "/b.txt" });
  assert.equal(fixture.messages.length, 0);
  fixture.receive({ type: "ready" });
  assert.deepEqual(fixture.messages, [{ type: "init", ...tab }, { type: "addTab", ...tab, path: "/b.txt" }]);
  assert.equal(getOrCreateDetachedEditorChannel(tab, async () => {}), channel);
});

test("late editor save completion and stale window close cannot affect a replacement channel", async () => {
  let finish!: () => void;
  const old = createDetachedEditorChannel(tab, () => new Promise<void>(resolve => { finish = resolve; }));
  const oldFixture = old as unknown as TestChannel;
  oldFixture.receive({ type: "save", path: tab.path, content: "updated", sessionId: tab.sessionId, saveId: "save-1" });
  closeDetachedEditorChannel(old);
  const current = createDetachedEditorChannel(tab, async () => {});
  closeDetachedEditorChannel(old);
  finish();
  await Promise.resolve();
  assert.equal((current as unknown as TestChannel).closed, false);
  assert.deepEqual(oldFixture.messages, []);
});
