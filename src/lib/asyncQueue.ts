export type AsyncQueue = {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  invalidate(): void;
};

export class AsyncQueueInvalidatedError extends Error {
  constructor() {
    super("异步操作已因状态刷新而失效");
    this.name = "AsyncQueueInvalidatedError";
  }
}

let globalGeneration = 0;

export function invalidateAsyncQueues() {
  globalGeneration += 1;
}

export function createAsyncQueue(): AsyncQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let generation = 0;
  return {
    enqueue<T>(task: () => Promise<T>) {
      const submittedGeneration = generation;
      const submittedGlobalGeneration = globalGeneration;
      const run = () => {
        if (
          submittedGeneration !== generation
          || submittedGlobalGeneration !== globalGeneration
        ) {
          throw new AsyncQueueInvalidatedError();
        }
        return task();
      };
      const result = tail.then(run, run);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    invalidate() {
      generation += 1;
    },
  };
}

export function isAsyncQueueInvalidatedError(error: unknown) {
  return error instanceof AsyncQueueInvalidatedError;
}
