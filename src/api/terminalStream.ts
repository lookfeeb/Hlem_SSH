import { Channel } from "@tauri-apps/api/core";
import { call, listenEvent } from "./bridge";
import { decodeTerminalFrame, TerminalConsumption } from "../lib/terminalFrame";
import type { TerminalClosedEvent, TerminalOutputEvent } from "../types";

const outputHandlers = new Set<(event: TerminalOutputEvent) => void>();
const closedHandlers = new Set<(event: TerminalClosedEvent) => void>();
const streams = new Map<string, TerminalConsumption>();
const decoder = new TextDecoder();

function terminalClosed(event: TerminalClosedEvent) {
  streams.get(event.terminalId)?.close();
  streams.delete(event.terminalId);
  for (const handler of closedHandlers) handler(event);
}

export async function startTerminalStream(terminalId: string) {
  if (streams.has(terminalId)) return;
  const fail = (error: unknown) => {
    console.error("[helm] terminal stream failed:", error);
    terminalClosed({ terminalId });
    void call<void>("terminal_close", { terminalId }).catch((closeError) => {
      console.warn("[helm] failed to close terminal after stream error:", closeError);
    });
  };
  const consumption = new TerminalConsumption((consumed) => {
    void call<void>("terminal_ack", { terminalId, consumed }).catch((error) => {
      // A failed acknowledgment must not leave the SSH reader blocked forever.
      if (streams.get(terminalId) === consumption) fail(error);
    });
  });
  streams.set(terminalId, consumption);
  const output = new Channel<ArrayBuffer>((buffer) => {
    if (streams.get(terminalId) !== consumption) return;
    try {
    const { kind, bytes } = decodeTerminalFrame(buffer);
    if (kind === "closed") { terminalClosed({ terminalId }); return; }
    let consumed = false;
    const onConsumed = () => {
      if (!consumed) { consumed = true; consumption.consume(bytes.byteLength); }
    };
    if (!outputHandlers.size) { onConsumed(); return; }
    const event: TerminalOutputEvent = {
      terminalId, kind,
      data: kind === "system" ? decoder.decode(bytes) : "",
      dataBytes: kind === "system" ? undefined : bytes,
      onConsumed,
    };
    for (const handler of outputHandlers) handler(event);
    } catch (error) { fail(error); }
  });
  try {
    await call<void>("terminal_start", { terminalId, output });
  } catch (error) {
    consumption.close();
    if (streams.get(terminalId) === consumption) streams.delete(terminalId);
    throw error;
  }
}

export async function onTerminalOutput(handler: (event: TerminalOutputEvent) => void) {
  outputHandlers.add(handler);
  return () => { outputHandlers.delete(handler); };
}

export async function onTerminalClosed(handler: (event: TerminalClosedEvent) => void) {
  closedHandlers.add(handler);
  // Only terminals closed before start use the lifecycle event fallback.
  let unlisten: () => void;
  try { unlisten = await listenEvent<TerminalClosedEvent>("terminal://closed", terminalClosed); }
  catch (error) { closedHandlers.delete(handler); throw error; }
  return () => { closedHandlers.delete(handler); unlisten(); };
}
