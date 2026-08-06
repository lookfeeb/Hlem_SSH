import assert from "node:assert/strict";
import test from "node:test";
import { contextMenuPositionInContainer } from "../src/components/fileManager/contextMenuPosition";

test("context menu coordinates are converted from viewport to the transformed table surface", () => {
  assert.deepEqual(
    contextMenuPositionInContainer(760, 540, {
      left: 410,
      top: 260,
      width: 800,
      height: 420,
    }),
    { x: 350, y: 280 },
  );
});

test("context menu anchor remains inside the table surface at viewport edges", () => {
  const bounds = { left: 400, top: 200, width: 600, height: 300 };
  assert.deepEqual(contextMenuPositionInContainer(200, 100, bounds), { x: 0, y: 0 });
  assert.deepEqual(contextMenuPositionInContainer(1200, 700, bounds), { x: 599, y: 299 });
});
