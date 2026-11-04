import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { TerminalPanel } from "../src/components/TerminalPanel";
import { createTerminalOutputEntry } from "../src/lib/session";
import { clearTerminalDirect, writeTerminalEntryDirect } from "../src/lib/terminalRegistry";
import type { RemoteSession } from "../src/types";
import "../src/styles/terminal.css";

// Isolated local fixture: no SSH connection, credentials, or native commands.
const terminalId = "terminal-benchmark";
const session = { id: "benchmark", name: "本地基准", host: "127.0.0.1", username: "bench", state: "connected", accent: "blue", favorite: false, currentPath: "/tmp", terminalId, terminal: [], filesPath: null, files: [], telemetry: {} } as RemoteSession;
let terminal: Terminal;
const originalWrite = Terminal.prototype.write;
Terminal.prototype.write = function (data, callback) {
  terminal = this;
  originalWrite.call(this, data, callback);
};
let setActive: (active: boolean) => void;
let setGpu: (active: boolean) => void;
let consumedInput: (() => void) | undefined;
const encoder = new TextEncoder();

function output(data: Uint8Array, done?: () => void) {
  writeTerminalEntryDirect(terminalId, createTerminalOutputEntry("output", data), done);
}
function Fixture() {
  const [active, changeActive] = useState(true);
  const [gpu, changeGpu] = useState(true);
  setActive = changeActive; setGpu = changeGpu;
  return <main style={{ height: "90vh", width: "95vw" }}><TerminalPanel session={session} active={active} scrollback={5000} webglEnabled={gpu} onResize={() => {}} onClear={() => clearTerminalDirect(terminalId)} onCwd={() => {}} onSendData={(text) => output(encoder.encode(text.replace(/\r/g, "\r\n")), consumedInput)} /></main>;
}
flushSync(() => createRoot(document.getElementById("root")!).render(<Fixture />));

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function quantiles(values: number[]) {
  values.sort((a, b) => a - b);
  return { p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1], maxMs: values.at(-1) };
}
async function bulk(bytes = 8 * 1024 * 1024, chunkSize = 65536, mixed = false) {
  const line = mixed ? "\x1b[32m中文输出✓\x1b[0m value=123456789\r\n" : "terminal-output-abcdefghijklmnopqrstuvwxyz-0123456789\r\n";
  const source = encoder.encode(line.repeat(Math.ceil(bytes / encoder.encode(line).length))).subarray(0, bytes);
  const started = performance.now();
  let submitMs = 0;
  // Match the native 1 MiB in-flight window.
  for (let windowStart = 0; windowStart < source.length; windowStart += 1024 * 1024) {
    const pending: Promise<void>[] = [];
    for (let offset = windowStart; offset < Math.min(windowStart + 1024 * 1024, source.length); offset += chunkSize) {
      const chunk = source.subarray(offset, Math.min(offset + chunkSize, source.length));
      const before = performance.now();
      pending.push(new Promise<void>((resolve) => output(chunk, resolve)));
      submitMs += performance.now() - before;
    }
    await Promise.all(pending);
  }
  const parsedMs = performance.now() - started;
  await frame(); await frame();
  return { bytes, chunkSize, mixed, submitMs, parsedMs, throughMiBps: bytes / 1024 / 1024 / (parsedMs / 1000), twoFramesMs: performance.now() - started };
}
Object.assign(window, { __HELM_TERMINAL_BENCH__: {
  bulk,
  output(text: string) { return new Promise<void>((resolve) => output(encoder.encode(text), resolve)); },
  async input(count = 100) {
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const started = performance.now();
      await new Promise<void>((resolve) => { consumedInput = resolve; terminal.input("a", true); });
      consumedInput = undefined;
      values.push(performance.now() - started);
    }
    return quantiles(values);
  },
  async activate(active: boolean) { flushSync(() => setActive(active)); await frame(); },
  async gpu(enabled: boolean) { flushSync(() => setGpu(enabled)); await frame(); await frame(); },
  get terminal() { return terminal; },
} });
setTimeout(() => output(encoder.encode("bench@local:/tmp$ ")), 0);
