import type {
  AiApiSettings,
  AppProxyOptions,
  BackupSettings,
  ConfigSnapshot,
  GroupInput,
  QuickCommand,
  SessionInput,
  SshOptions,
  TunnelInput,
} from "../types";
import { call } from "./bridge";

export const vaultApi = {
  needsMigration: () => call<boolean>("vault_needs_migration"),
  migrate: (oldPassword: string) => call<ConfigSnapshot>("vault_migrate", { oldPassword }),
  skipMigration: () => call<ConfigSnapshot>("vault_skip_migration"),
  snapshot: () => call<ConfigSnapshot>("config_snapshot", undefined, { retries: 1 }),
  backupExport: (path: string) => call<void>("vault_backup_export", { path }, { timeoutMs: 15 * 60_000 }),
  backupImport: (path: string) => call<ConfigSnapshot>("vault_backup_import", { path }, { timeoutMs: 15 * 60_000 }),
  backupRunNow: () => call<ConfigSnapshot>("backup_run_now", undefined, { timeoutMs: 15 * 60_000 }),
  backupRecordRestore: (recordId: string) =>
    call<ConfigSnapshot>("backup_record_restore", { recordId }, { timeoutMs: 15 * 60_000 }),
  backupRecordDelete: (recordId: string, deleteFile = false) =>
    call<ConfigSnapshot>("backup_record_delete", { recordId, deleteFile }),
  backupRecordsClear: () => call<ConfigSnapshot>("backup_records_clear"),
  settingsProxyUpdate: (proxy: AppProxyOptions | null) =>
    call<ConfigSnapshot>("settings_proxy_update", { proxy }),
  settingsBackupUpdate: (backup: BackupSettings) =>
    call<ConfigSnapshot>("settings_backup_update", { backup }),
  quickCommandUpsert: (command: QuickCommand) =>
    call<ConfigSnapshot>("quick_command_upsert", { command }),
  quickCommandDelete: (commandId: string) =>
    call<ConfigSnapshot>("quick_command_delete", { commandId }),
  settingsAiApiUpdate: (settings: AiApiSettings) =>
    call<ConfigSnapshot>("settings_ai_api_update", {
      sessionIds: settings.sessionIds,
      port: settings.port ?? null,
      autoStart: settings.autoStart,
    }),
  settingsIgnoreUpdateVersion: (version: string) =>
    call<ConfigSnapshot>("settings_ignore_update_version", { version }),
  connectionSectionStateUpdate: (collapsedSectionIds: string[]) =>
    call<ConfigSnapshot>("connection_section_state_update", { collapsedSectionIds }),
  groupCreate: (input: GroupInput) => call<ConfigSnapshot>("group_create", { input }),
  groupUpdate: (groupId: string, input: GroupInput) => call<ConfigSnapshot>("group_update", { groupId, input }),
  groupDelete: (groupId: string) => call<ConfigSnapshot>("group_delete", { groupId }),
  sessionCreate: (input: SessionInput) => call<ConfigSnapshot>("session_create", { input }),
  sessionUpdate: (sessionId: string, input: SessionInput) => call<ConfigSnapshot>("session_update", { sessionId, input }),
  sessionFavoriteUpdate: (sessionId: string, favorite: boolean) =>
    call<ConfigSnapshot>("session_favorite_update", { sessionId, favorite }),
  sessionMarkRecent: (sessionId: string) =>
    call<ConfigSnapshot>("session_mark_recent", { sessionId }),
  sessionClearRecent: (sessionId: string) =>
    call<ConfigSnapshot>("session_clear_recent", { sessionId }),
  sessionDelete: (sessionId: string) => call<ConfigSnapshot>("session_delete", { sessionId }),
  tunnelCreate: (input: TunnelInput) => call<ConfigSnapshot>("tunnel_create", { input }),
  tunnelUpdate: (tunnelId: string, input: TunnelInput) => call<ConfigSnapshot>("tunnel_update", { tunnelId, input }),
  tunnelDelete: (tunnelId: string) => call<ConfigSnapshot>("tunnel_delete", { tunnelId }),
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
