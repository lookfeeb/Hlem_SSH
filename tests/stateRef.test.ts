import assert from "node:assert/strict";
import test from "node:test";
import { commitRefState } from "../src/lib/stateRef";

test("state ref is updated synchronously before the render setter is observed", () => {
  const stateRef = { current: ["a"] };
  const observed: string[][] = [];
  const setState = (value: string[] | ((current: string[]) => string[])) => {
    assert.equal(typeof value, "object");
    observed.push(value as string[]);
  };

  const next = commitRefState(stateRef, setState, (current) => [...current, "b"]);

  assert.deepEqual(next, ["a", "b"]);
  assert.strictEqual(stateRef.current, next);
  assert.strictEqual(observed[0], next);
});

test("sequential functional commits use the latest ref instead of a stale render snapshot", () => {
  const stateRef = { current: 0 };
  let rendered = 0;
  const setState = (value: number | ((current: number) => number)) => {
    rendered = typeof value === "function" ? value(rendered) : value;
  };

  commitRefState(stateRef, setState, (current) => current + 1);
  commitRefState(stateRef, setState, (current) => current + 1);

  assert.equal(stateRef.current, 2);
  assert.equal(rendered, 2);
});
