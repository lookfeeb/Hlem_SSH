import assert from "node:assert/strict";
import test from "node:test";
import {
  addConnectingSessionId,
  activeSessionIdAfterClose,
  connectingSessionIdsFor,
  formatReconnectCountdownNotice,
  normalizeDisconnectReason,
  ReconnectCountdown,
  remainingOpenSessionIds,
  removeConnectingSessionIds,
  type ReconnectCountdownScheduler,
} from "../src/app/sessionConnectionState";

class ManualCountdownScheduler implements ReconnectCountdownScheduler {
  private currentTime = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

  now = () => this.currentTime;

  setTimeout = (callback: () => void, delayMs: number) => {
    const handle = this.nextHandle++;
    this.timers.set(handle, { dueAt: this.currentTime + delayMs, callback });
    return handle;
  };

  clearTimeout = (handle: number) => {
    this.timers.delete(handle);
  };

  advance(milliseconds: number) {
    const targetTime = this.currentTime + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= targetTime)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      const [handle, timer] = next;
      this.timers.delete(handle);
      this.currentTime = timer.dueAt;
      timer.callback();
    }
    this.currentTime = targetTime;
  }
}

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

test("closing tabs preserves a newer active selection made while cleanup is pending", () => {
  const closing = new Set(["session-a"]);
  const remaining = remainingOpenSessionIds(["session-a", "session-b", "session-c"], closing);

  assert.deepEqual(remaining, ["session-b", "session-c"]);
  assert.equal(activeSessionIdAfterClose("session-a", remaining, closing), "session-b");
  assert.equal(activeSessionIdAfterClose("session-c", remaining, closing), "session-c");
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

test("generic disconnect text is replaced with an explicit lack-of-detail reason", () => {
  assert.equal(
    normalizeDisconnectReason("Disconnected"),
    "服务器未返回具体原因",
  );
  assert.equal(
    normalizeDisconnectReason("远端重置了 TCP 连接"),
    "远端重置了 TCP 连接",
  );
});

test("connection timeout text is compact and uses human-readable seconds", () => {
  assert.equal(
    normalizeDisconnectReason("连接意外断开，原因：SSH 连接超时：TCP、协议协商或密钥交换未在 10000 毫秒内完成"),
    "SSH 建连超时（TCP、协议协商或密钥交换超过 10 秒）",
  );
});

test("reconnect notice distinguishes the failed attempt from the next countdown", () => {
  assert.equal(
    formatReconnectCountdownNotice({
      previousAttempts: 2,
      nextAttempt: 3,
      remainingSeconds: 10,
      failureReason: "SSH 连接超时：TCP、协议协商或密钥交换未在 10000 毫秒内完成",
    }),
    "第 2 次重连失败：SSH 建连超时（TCP、协议协商或密钥交换超过 10 秒）；第 3 次重连倒计时：10 秒",
  );
});

test("reconnect countdown updates every second and fires once at the deadline", () => {
  const scheduler = new ManualCountdownScheduler();
  const ticks: number[] = [];
  let elapsed = 0;
  const countdown = new ReconnectCountdown({
    delayMs: 3000,
    scheduler,
    onTick: (seconds) => ticks.push(seconds),
    onElapsed: () => {
      elapsed += 1;
    },
  });

  countdown.start();
  assert.deepEqual(ticks, [3]);
  scheduler.advance(999);
  assert.deepEqual(ticks, [3]);
  scheduler.advance(1);
  assert.deepEqual(ticks, [3, 2]);
  scheduler.advance(1000);
  assert.deepEqual(ticks, [3, 2, 1]);
  scheduler.advance(1000);
  assert.equal(elapsed, 1);
});

test("cancelled reconnect countdown cannot start a reconnect later", () => {
  const scheduler = new ManualCountdownScheduler();
  let elapsed = 0;
  const countdown = new ReconnectCountdown({
    delayMs: 2000,
    scheduler,
    onTick: () => undefined,
    onElapsed: () => {
      elapsed += 1;
    },
  });

  countdown.start();
  scheduler.advance(1000);
  countdown.cancel();
  scheduler.advance(5000);
  assert.equal(elapsed, 0);
});
