import assert from "node:assert/strict";
import { test } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { recordStartupPhase, showMainWindow } from "../src/lib/startup";

test("startup can show the shell without animation frames, deduplicates requests, and retries a failed handshake", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    requestAnimationFrame: () => { throw new Error("hidden WebView has no animation frames"); },
  } });
  const commands: string[] = [];
  let fail = true;
  mockIPC((command) => {
    commands.push(command);
    if (command === "frontend_ready" && fail) throw new Error("not ready yet");
  });
  try {
    await assert.rejects(showMainWindow(), /not ready yet/);
    fail = false;
    await Promise.all([showMainWindow(), showMainWindow()]);
    await showMainWindow();
    recordStartupPhase("shell-committed");
    recordStartupPhase("shell-committed");
    assert.equal(commands.filter(command => command === "frontend_ready").length, 2);
    assert.equal(commands.filter(command => command === "startup_phase").length, 1);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
