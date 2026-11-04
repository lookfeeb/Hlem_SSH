import assert from "node:assert/strict";
import test from "node:test";
import { TerminalRenderer, terminalRendererCount } from "../src/lib/terminalRenderer";

function factory() {
  const state = { creates: 0, disposes: 0, loss: () => {} };
  return { state, create: async () => {
    state.creates++;
    return { activate() {}, dispose() { state.disposes++; }, onContextLoss(callback: () => void) { state.loss = callback; return { dispose() { state.loss = () => {}; } }; } };
  } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test("quick tab switches reuse the GPU context and context loss falls back once", async () => {
  const f = factory();
  const renderer = new TerminalRenderer({ loadAddon() {} }, f.create);
  try {
    renderer.update(true, true); await flush();
    renderer.update(true, false); renderer.update(true, true); await flush();
    assert.equal(f.state.creates, 1);
    f.state.loss();
    assert.equal(f.state.disposes, 1);
    assert.equal(terminalRendererCount(), 0);
  } finally { renderer.dispose(); }
  assert.equal(f.state.disposes, 1);
});

test("GPU leases are bounded and background leases expire", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fs = [factory(), factory(), factory()];
  const renderers = fs.map((f) => new TerminalRenderer({ loadAddon() {} }, f.create));
  try {
    renderers[0].update(true, true); await flush(); renderers[0].update(true, false);
    renderers[1].update(true, true); await flush(); renderers[1].update(true, false);
    renderers[2].update(true, true); await flush();
    assert.equal(terminalRendererCount(), 2);
    assert.equal(fs[0].state.disposes, 1);
    t.mock.timers.tick(5001);
    assert.equal(terminalRendererCount(), 1);
  } finally { renderers.forEach((r) => r.dispose()); }
  assert.equal(terminalRendererCount(), 0);
});

test("late renderer imports cannot reactivate disposed terminals", async () => {
  const f = factory();
  let resolve!: (addon: Awaited<ReturnType<typeof f.create>>) => void;
  const renderer = new TerminalRenderer({ loadAddon() { assert.fail("must not activate"); } }, () => new Promise((done) => { resolve = done; }));
  renderer.update(true, true);
  renderer.dispose();
  resolve(await f.create()); await flush();
  assert.equal(f.state.disposes, 1);
  assert.equal(terminalRendererCount(), 0);
});
