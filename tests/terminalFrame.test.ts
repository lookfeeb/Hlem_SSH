import assert from "node:assert/strict";
import test from "node:test";
import { decodeTerminalFrame, TerminalConsumption } from "../src/lib/terminalFrame";

test("binary frames preserve UTF-8 fragments and control bytes without copying", () => {
  const bytes = new TextEncoder().encode("中文\x1b[31m\x00");
  const reconstructed: number[] = [];
  for (const byte of bytes) {
    const buffer = new Uint8Array([0, byte]).buffer;
    const frame = decodeTerminalFrame(buffer);
    assert.equal(frame.bytes.buffer, buffer);
    assert.equal(frame.kind, "output");
    reconstructed.push(...frame.bytes);
  }
  assert.deepEqual(new Uint8Array(reconstructed), bytes);
  assert.equal(decodeTerminalFrame(new Uint8Array([1, 255]).buffer).kind, "error");
  assert.equal(decodeTerminalFrame(new Uint8Array([2, 65]).buffer).kind, "system");
  assert.equal(decodeTerminalFrame(new Uint8Array([3]).buffer).kind, "closed");
  assert.throws(() => decodeTerminalFrame(new ArrayBuffer(0)));
  assert.throws(() => decodeTerminalFrame(new Uint8Array([4]).buffer));
  assert.throws(() => decodeTerminalFrame(new Uint8Array([3, 1]).buffer));
});

test("consumption credits are cumulative and coalesced, then stop on close", async () => {
  const credits: number[] = [];
  const consumed = new TerminalConsumption(value => credits.push(value));
  consumed.consume(32768);
  assert.deepEqual(credits, []);
  consumed.consume(32768);
  assert.deepEqual(credits, [65536]);
  consumed.consume(10);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(credits, [65536, 65546]);
  consumed.consume(1);
  consumed.close();
  consumed.consume(65536);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(credits, [65536, 65546]);
});
