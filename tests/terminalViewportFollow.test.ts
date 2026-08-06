import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetTerminalDirect,
  registerTerminalSink,
  writeTerminalEntryDirect,
} from "../src/lib/terminalRegistry";
import {
  TerminalViewportFollower,
  type TerminalViewportFollowScheduler,
} from "../src/lib/terminalViewportFollow";
import type { TerminalEntry } from "../src/types";

class ManualScheduler implements TerminalViewportFollowScheduler {
  private nextHandle = 1;
  private readonly timers = new Map<number, () => void>();
  private readonly frames = new Map<number, () => void>();

  setTimeout(callback: () => void) {
    const handle = this.nextHandle++;
    this.timers.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: number) {
    this.timers.delete(handle);
  }

  requestAnimationFrame(callback: () => void) {
    const handle = this.nextHandle++;
    this.frames.set(handle, callback);
    return handle;
  }

  cancelAnimationFrame(handle: number) {
    this.frames.delete(handle);
  }

  flushOneFrame() {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    callbacks.forEach((callback) => callback());
  }

  flushAll() {
    for (let pass = 0; pass < 20 && (this.timers.size > 0 || this.frames.size > 0); pass += 1) {
      const timers = [...this.timers.values()];
      this.timers.clear();
      timers.forEach((callback) => callback());
      this.flushOneFrame();
    }
    assert.equal(this.timers.size, 0, "settle timers should drain");
    assert.equal(this.frames.size, 0, "settle frames should drain");
  }
}

function outputEntry(id: string, content: string): TerminalEntry {
  return {
    id,
    kind: "output",
    content,
    timestamp: "00:00:00",
  };
}

test("long asynchronous MOTD output settles at the newest prompt after a late layout", () => {
  const scheduler = new ManualScheduler();
  let viewport = 0;
  let bottom = 0;
  const follower = new TerminalViewportFollower(() => {
    viewport = bottom;
  }, scheduler);

  follower.attach("terminal-long-motd");
  scheduler.flushAll();

  for (const chunkRows of [12, 18, 9, 1]) {
    bottom += chunkRows;
    follower.handleWriteComplete("terminal-long-motd");
  }

  viewport = 7;
  follower.handleLayoutComplete("terminal-long-motd");
  scheduler.flushOneFrame();
  assert.equal(viewport, 7, "the first frame must wait for layout to stabilize");
  scheduler.flushOneFrame();
  assert.equal(viewport, bottom);
});

test("a rebuilt sink replay also settles at the bottom after asynchronous writes", () => {
  const terminalId = "terminal-rebuilt-sink";
  const scheduler = new ManualScheduler();
  let viewport = 0;
  let bottom = 0;
  const parsedWrites: Array<() => void> = [];
  const follower = new TerminalViewportFollower(() => {
    viewport = bottom;
  }, scheduler);

  try {
    writeTerminalEntryDirect(terminalId, outputEntry("motd-1", "line 1\r\n"));
    writeTerminalEntryDirect(terminalId, outputEntry("motd-2", "line 2\r\n"));
    const unregister = registerTerminalSink(terminalId, { writeEntry: () => undefined });
    unregister();

    follower.attach(terminalId);
    registerTerminalSink(terminalId, {
      writeEntry: () => {
        bottom += 1;
        parsedWrites.push(() => follower.handleWriteComplete(terminalId));
      },
    });

    assert.equal(parsedWrites.length, 2);
    parsedWrites.forEach((completeWrite) => completeWrite());
    viewport = 0;
    follower.handleLayoutComplete(terminalId);
    scheduler.flushAll();
    assert.equal(viewport, bottom);
  } finally {
    follower.dispose();
    forgetTerminalDirect(terminalId);
  }
});

test("manual viewport navigation disables startup following", () => {
  const scheduler = new ManualScheduler();
  let viewport = 0;
  let bottom = 80;
  const follower = new TerminalViewportFollower(() => {
    viewport = bottom;
  }, scheduler);

  follower.attach("terminal-user-scroll");
  scheduler.flushAll();
  viewport = 24;
  follower.detach("terminal-user-scroll");

  bottom = 120;
  follower.handleWriteComplete("terminal-user-scroll");
  follower.handleLayoutComplete("terminal-user-scroll");
  scheduler.flushAll();

  assert.equal(follower.shouldFollow("terminal-user-scroll"), false);
  assert.equal(viewport, 24);
});
