import assert from "node:assert/strict";
import test from "node:test";
import {
  createExclusiveAsyncRunner,
  ExclusiveAsyncOperationBusyError,
} from "../src/lib/exclusiveAsync";

test("exclusive async runner rejects overlapping work synchronously", async () => {
  const runner = createExclusiveAsyncRunner("备份操作正在进行");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = runner.run(async () => gate);

  assert.equal(runner.isRunning(), true);
  await assert.rejects(
    runner.run(async () => undefined),
    (error) => error instanceof ExclusiveAsyncOperationBusyError
      && error.message === "备份操作正在进行",
  );

  release();
  await first;
  assert.equal(runner.isRunning(), false);
});

test("exclusive async runner releases the gate after failures", async () => {
  const runner = createExclusiveAsyncRunner();

  await assert.rejects(runner.run(async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await runner.run(async () => "next"), "next");
});

test("exclusive async runner releases the gate after a synchronous throw", async () => {
  const runner = createExclusiveAsyncRunner();

  await assert.rejects(
    runner.run((() => { throw new Error("sync failed"); }) as () => Promise<void>),
    /sync failed/,
  );
  assert.equal(runner.isRunning(), false);
});
