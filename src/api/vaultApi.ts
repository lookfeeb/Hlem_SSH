import type { AppSettings, BackupSettings, ConfigSnapshot, GroupInput, SessionInput, SshOptions, TunnelConfig, TunnelInput } from "../types";
import { call } from "./bridge";

export const vaultApi = {
  needsMigration: () => call<boolean>("vault_needs_migration"),
  migrate: (oldPassword: string) => call<ConfigSnapshot>("vault_migrate", { oldPassword }),
  skipMigration: () => call<ConfigSnapshot>("vault_skip_migration"),
  snapshot: () => call<ConfigSnapshot>("config_snapshot"),
  backupExport: (path: string) => call<void>("vault_backup_export", { path }),
  backupImport: (path: string) => call<ConfigSnapshot>("vault_backup_import", { path }),
  backupRunNow: () => call<ConfigSnapshot>("backup_run_now"),
  backupRecordRestore: (recordId: string) => call<ConfigSnapshot>("backup_record_restore", { recordId }),
  backupRecordDelete: (recordId: string, deleteFile = false) =>
    call<ConfigSnapshot>("backup_record_delete", { recordId, deleteFile }),
  backupRecordsClear: () => call<ConfigSnapshot>("backup_records_clear"),
  settingsUpdate: (settings: AppSettings) => call<ConfigSnapshot>("settings_update", { settings }),
  groupCreate: (input: GroupInput) => call<ConfigSnapshot>("group_create", { input }),
  groupUpdate: (groupId: string, input: GroupInput) => call<ConfigSnapshot>("group_update", { groupId, input }),
  groupDelete: (groupId: string) => call<ConfigSnapshot>("group_delete", { groupId }),
  sessionCreate: (input: SessionInput) => call<ConfigSnapshot>("session_create", { input }),
  sessionUpdate: (sessionId: string, input: SessionInput) => call<ConfigSnapshot>("session_update", { sessionId, input }),
  sessionFavoriteUpdate: (sessionId: string, favorite: boolean) =>
    callWithCommandFallback<ConfigSnapshot>("session_favorite_update", "sessionFavoriteUpdate", { sessionId, favorite }),
  sessionMarkRecent: (sessionId: string) =>
    callWithCommandFallback<ConfigSnapshot>("session_mark_recent", "sessionMarkRecent", { sessionId }),
  sessionDelete: (sessionId: string) => call<ConfigSnapshot>("session_delete", { sessionId }),
  sessionDuplicate: (sessionId: string) => call<ConfigSnapshot>("session_duplicate", { sessionId }),
  tunnelCreate: (input: TunnelInput) => call<ConfigSnapshot>("tunnel_create", { input }),
  tunnelUpdate: (tunnelId: string, input: TunnelInput) => call<ConfigSnapshot>("tunnel_update", { tunnelId, input }),
  tunnelDelete: (tunnelId: string) => call<ConfigSnapshot>("tunnel_delete", { tunnelId }),
  tunnelList: () => call<TunnelConfig[]>("tunnel_list"),
};

export function emptyPasswordAuth() {
  return {
    method: "password" as const,
    password: null,
    privateKeyPath: null,
    importedPrivateKey: null,
    privateKeyPassphrase: null,
  };
}

export function defaultTerminalOptions() {
  return {
    encoding: "utf-8",
    theme: "default",
    keepaliveIntervalSec: 15,
  };
}

export function defaultSshOptions(): SshOptions {
  return {
    connectTimeoutMs: 10000,
    keepaliveIntervalSec: 15,
    hostKeyFingerprint: null,
    proxy: null,
  };
}

export function defaultSftpOptions() {
  return {
    defaultPath: "",
    showHidden: false,
  };
}

export function defaultBackupSettings(): BackupSettings {
  return {
    localDirectory: null,
    autoEnabled: false,
    frequency: "daily",
    retentionCount: 10,
    retentionDays: 30,
    cloud: {
      enabled: false,
      autoEnabled: false,
      kind: "webdav",
      webdav: {
        endpoint: "",
        username: "",
        password: "",
        remotePath: "",
      },
      s3: {
        endpoint: "",
        region: "us-east-1",
        bucket: "",
        accessKeyId: "",
        secretAccessKey: "",
        prefix: "helm",
        pathStyle: false,
      },
    },
  };
}

async function callWithCommandFallback<T>(
  command: string,
  fallbackCommand: string,
  args: Record<string, unknown>,
) {
  try {
    return await call<T>(command, args);
  } catch (error) {
    if (!isCommandNotFound(error)) throw error;
    try {
      return await call<T>(fallbackCommand, args);
    } catch (fallbackError) {
      throw isCommandNotFound(fallbackError) ? error : fallbackError;
    }
  }
}

function isCommandNotFound(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /command .* not found/i.test(message);
}
