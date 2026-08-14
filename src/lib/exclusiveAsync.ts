export type ExclusiveAsyncRunner = {
  run<T>(task: () => Promise<T>): Promise<T>;
  isRunning(): boolean;
};

export class ExclusiveAsyncOperationBusyError extends Error {
  constructor(message = "已有操作正在进行，请稍候") {
    super(message);
    this.name = "ExclusiveAsyncOperationBusyError";
  }
}

export function createExclusiveAsyncRunner(
  busyMessage?: string,
): ExclusiveAsyncRunner {
  let running = false;
  return {
    run<T>(task: () => Promise<T>) {
      if (running) {
        return Promise.reject(new ExclusiveAsyncOperationBusyError(busyMessage));
      }
      running = true;
      let result: Promise<T>;
      try {
        result = task();
      } catch (error) {
        running = false;
        return Promise.reject(error);
      }
      return Promise.resolve(result).finally(() => {
        running = false;
      });
    },
    isRunning() {
      return running;
    },
  };
}
