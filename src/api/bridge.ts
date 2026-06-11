import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./runtime";

export type Unlisten = () => void;

export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) return Promise.reject(new Error("HelM 仅支持 Tauri 运行环境"));
  return invoke<T>(command, args);
}

export async function listenEvent<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
  if (!isTauriRuntime()) return () => undefined;
  return listen<T>(event, (message) => handler(message.payload));
}
