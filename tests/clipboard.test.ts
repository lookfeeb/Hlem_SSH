import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { readClipboardText, writeClipboardText } from "../src/lib/clipboard";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let browserCalls = 0;

beforeEach(() => {
  browserCalls = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        readText: async () => {
          browserCalls += 1;
          throw new Error("NotAllowedError: browser clipboard permission denied");
        },
        writeText: async () => {
          browserCalls += 1;
          throw new Error("NotAllowedError: browser clipboard permission denied");
        },
      },
    },
  });
});

afterEach(() => {
  for (const [key, descriptor] of [["window", originalWindow], ["navigator", originalNavigator]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("desktop reads native clipboard even when browser clipboard permission was denied", async () => {
  mockIPC((command) => {
    assert.equal(command, "plugin:clipboard-manager|read_text");
    return "中文命令\r\nsecond line";
  });
  assert.equal(await readClipboardText(), "中文命令\r\nsecond line");
  assert.equal(browserCalls, 0);
});

test("desktop copies through the native clipboard without browser permission", async () => {
  const writes: unknown[] = [];
  mockIPC((command, payload) => {
    assert.equal(command, "plugin:clipboard-manager|write_text");
    writes.push((payload as { text: string }).text);
  });
  assert.equal(await writeClipboardText("复制内容"), true);
  assert.deepEqual(writes, ["复制内容"]);
  assert.equal(browserCalls, 0);
});

test("native read failures reach the caller instead of looking like an empty clipboard", async () => {
  mockIPC(() => { throw new Error("clipboard busy"); });
  await assert.rejects(readClipboardText(), /clipboard busy/);
  assert.equal(browserCalls, 0);
});

test("empty native clipboard does not fall back to the browser", async () => {
  mockIPC(() => "");
  assert.equal(await readClipboardText(), "");
  assert.equal(browserCalls, 0);
});

test("browser preview surfaces denied clipboard permission", async () => {
  await assert.rejects(readClipboardText(), /permission denied/);
  assert.equal(browserCalls, 1);
});
