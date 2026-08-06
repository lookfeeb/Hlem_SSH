import type { AppInfo, UpdateInfo } from "../types";
import { call } from "./bridge";

const DEFAULT_UPDATE_REPO = "lookfeeb/Hlem_SSH";

export type LocalExpandedEntry = {
  localPath: string;
  relativePath: string;
};

export type ApiServerInfo = {
  running: boolean;
  port: number;
  apiKey: string;
};

export type ApiLogEntry = {
  timestamp: string;
  action: string;
  detail: string;
  success: boolean;
  durationMs: number;
  response?: string | null;
};

export const appApi = {
  info: () => call<AppInfo>("app_info", undefined, { retries: 1 }),
  updateRepo: () => DEFAULT_UPDATE_REPO,
  checkUpdate: (currentVersion: string, currentArch = "") =>
    call<UpdateInfo | null>("check_update", { currentVersion, currentArch }, { retries: 1, timeoutMs: 45_000 }),
  downloadUpdate: (url: string, fileName?: string | null) =>
    call<string>("download_update", { url, fileName }, { timeoutMs: 15 * 60_000 }),
  downloadSignedUpdate: (url: string, fileName?: string | null, sha256?: string | null) =>
    call<string>("download_update", { url, fileName, sha256 }, { timeoutMs: 15 * 60_000 }),
  installUpdate: (installerPath: string) => call<void>("install_update", { installerPath }, { timeoutMs: 5 * 60_000 }),
  openDatabaseDir: () => call<void>("open_database_dir"),
  openPathDir: (path: string) => call<void>("open_path_dir", { path }),
  localPathExists: (path: string) => call<boolean>("local_path_exists", { path }, { retries: 1 }),
  createLocalDirectories: (paths: string[]) => call<void>("local_create_directories", { paths }),
  openExternalUrl: (url: string) => call<void>("open_external_url", { url }),
  expandLocalPaths: (paths: string[]) => call<LocalExpandedEntry[]>("local_expand_paths", { paths }, { timeoutMs: 5 * 60_000 }),
  apiServerStart: (port: number, allowedSessionIds?: string[] | string | null) => {
    const ids = normalizeSessionIds(allowedSessionIds);
    return call<ApiServerInfo>("api_server_start", {
      port,
      allowedSessionId: ids[0] ?? null,
      allowedSessionIds: ids,
    });
  },
  apiServerStop: () => call<void>("api_server_stop"),
  apiServerUpdateSessions: (allowedSessionIds?: string[] | string | null) => {
    const ids = normalizeSessionIds(allowedSessionIds);
    return call<ApiServerInfo>("api_server_update_sessions", {
      allowedSessionId: ids[0] ?? null,
      allowedSessionIds: ids,
    });
  },
  apiServerStatus: () => call<ApiServerInfo>("api_server_status", undefined, { retries: 1 }),
  apiServerRegenerateKey: () => call<ApiServerInfo>("api_server_regenerate_key"),
  apiServerLogs: () => call<ApiLogEntry[]>("api_server_logs", undefined, { retries: 1 }),
};

function normalizeSessionIds(value?: string[] | string | null) {
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === "string" && id.length > 0);
  return value ? [value] : [];
}
