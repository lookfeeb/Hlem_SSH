import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./runtime";
import { unknownErrorMessage } from "../lib/errors";

export type Unlisten = () => void;

type CallOptions = {
  timeoutMs?: number;
  retries?: number;
};

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 300;
const NOOP_UNLISTEN: Unlisten = () => {};

export async function call<T>(
  command: string,
  args?: Record<string, unknown>,
  options: CallOptions = {},
): Promise<T> {
  if (!isTauriRuntime()) return Promise.reject(new Error("HelM 仅支持 Tauri 运行环境"));
  const attempts = Math.max(1, (options.retries ?? 0) + 1);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withTimeout(
        invoke<T>(command, args),
        options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        command,
      );
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableInvokeError(error)) break;
      await delay(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

export async function listenEvent<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
  if (!isTauriRuntime()) return NOOP_UNLISTEN;
  return listen<T>(event, (message) => handler(message.payload));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, command: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(`调用 ${command} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isRetryableInvokeError(error: unknown) {
  const message = unknownErrorMessage(error);
  return /超时|timeout|temporarily|network|connection reset|通道.*关闭/i.test(message);
}
