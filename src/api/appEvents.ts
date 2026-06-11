import { listenEvent } from "./bridge";
import type { ApiLogEntry } from "./appApi";
import type { ConfigSnapshot } from "../types";

type TrayAction = "lock" | "settings" | "backup" | "backupNow";
type Unlisten = () => void;

export const appEvents = {
  onTrayAction: async (handler: (action: TrayAction) => void): Promise<Unlisten> => {
    return listenEvent("tray://action", handler);
  },
  /**
   * 后端 push_log 时实时推送的单条日志。订阅它代替原来 500ms 轮询 apiServerLogs()，
   * 既不抢 Tokio Mutex，也避免空轮询时仍消耗后端 CPU/锁。
   */
  onApiLog: async (handler: (entry: ApiLogEntry) => void): Promise<Unlisten> => {
    return listenEvent("api://log", handler);
  },
  onConfigChanged: async (handler: (snapshot: ConfigSnapshot) => void): Promise<Unlisten> => {
    return listenEvent("config://changed", handler);
  },
};
