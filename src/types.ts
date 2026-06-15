export type ConnectionState = "connected" | "connecting" | "disconnected" | "failed";

export interface RemoteSession {
  id: string;
  name: string;
  groupId?: string | null;
  host: string;
  username: string;
  state: ConnectionState;
  accent: string;
  favorite: boolean;
  lastConnectedAt?: string | null;
  currentPath: string;
  connectionId?: string | null;
  connectedAt?: string | null;
  sshVersion?: string | null;
  terminalId?: string | null;
  sftpId?: string | null;
  telemetryJobId?: string | null;
  terminal: TerminalEntry[];
  telemetry: ServerTelemetry;
  files: RemoteFileEntry[];
}

export interface TerminalEntry {
  id: string;
  kind: "system" | "input" | "output" | "error";
  content: string;
  dataBase64?: string;
  timestamp: string;
}

export interface ServerTelemetry {
  ip: string;
  ipv6: string;
  uptime: string;
  cpu: number;
  memory: UsageMetric;
  swap: UsageMetric;
  processes: ProcessInfo[];
  network: NetworkMetric;
  disks: DiskMetric[];
}

export interface UsageMetric {
  used: number;
  total: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
}

export interface NetworkMetric {
  interfaceName: string;
  uploadKbps: number;
  downloadKbps: number;
  latencyMs: number;
  interfaces: NetworkInterfaceMetric[];
}

export interface NetworkInterfaceMetric {
  interfaceName: string;
  uploadKbps: number;
  downloadKbps: number;
  rxBytes: number;
  txBytes: number;
  linkSpeedMbps?: number | null;
}

export interface DiskMetric {
  mount: string;
  used: number;
  total: number;
}

export type FileType = "directory" | "file";

export interface RemoteFileEntry {
  key: string;
  name: string;
  path: string;
  fileType: FileType | "symlink" | "other";
  size: number;
  modifiedAt: string;
  permissions: string;
  owner: string;
}

export interface ConfigSnapshot {
  data: VaultData;
}

export interface VaultData {
  version: number;
  groups: SessionGroup[];
  sessions: SessionConfig[];
  knownHosts: KnownHostEntry[];
  settings: AppSettings;
  tunnels: TunnelConfig[];
  backupRecords: BackupRecord[];
  updatedAt: string;
}

export interface AppSettings {
  proxy?: AppProxyOptions | null;
  backup: BackupSettings;
  quickCommands?: QuickCommand[];
  ignoredUpdateVersions?: string[];
  aiApiKey?: string | null;
  aiApiSessionId?: string | null;
  aiApiSessionIds?: string[];
  aiApiPort?: number | null;
  aiApiAutoStart?: boolean;
}

export interface QuickCommand {
  id: string;
  name: string;
  command: string;
  clickCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface AppProxyOptions {
  enabled: boolean;
  kind: "socks5" | "httpConnect";
  host: string;
  port: number;
}

export interface BackupSettings {
  localDirectory?: string | null;
  autoEnabled: boolean;
  frequency: "manual" | "hourly" | "daily" | "weekly";
  retentionCount: number;
  retentionDays: number;
  cloud: CloudBackupSettings;
}

export interface CloudBackupSettings {
  enabled: boolean;
  autoEnabled: boolean;
  kind: "webdav" | "s3";
  webdav: WebdavBackupConfig;
  s3: S3BackupConfig;
}

export interface WebdavBackupConfig {
  endpoint: string;
  username: string;
  password: string;
  remotePath: string;
}

export interface S3BackupConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  pathStyle: boolean;
}

export interface BackupRecord {
  id: string;
  fileName: string;
  targetKind: "local" | "webdav" | "s3" | "cloud";
  targetPath: string;
  size: number;
  status: "success" | "failed";
  error?: string | null;
  createdAt: string;
}

export interface KnownHostEntry {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  trustedAt: string;
}

export interface SessionGroup {
  id: string;
  name: string;
  parentId?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionConfig {
  id: string;
  name: string;
  groupId?: string | null;
  favorite?: boolean;
  lastConnectedAt?: string | null;
  host: string;
  port: number;
  username: string;
  auth: AuthConfig;
  ssh: SshOptions;
  defaultPath: string;
  tags: string[];
  note?: string | null;
  terminal: TerminalOptions;
  sftp: SftpOptions;
  createdAt: string;
  updatedAt: string;
}

export interface AuthConfig {
  method: "password" | "privateKey";
  password?: string | null;
  privateKeyPath?: string | null;
  importedPrivateKey?: string | null;
  privateKeyPassphrase?: string | null;
}

export interface TerminalOptions {
  encoding: string;
  theme: string;
  keepaliveIntervalSec: number;
}

export interface SshOptions {
  connectTimeoutMs: number;
  keepaliveIntervalSec: number;
  hostKeyFingerprint?: string | null;
  proxy?: SshProxyOptions | null;
}

export interface SshProxyOptions {
  kind: "direct" | "socks5" | "httpConnect";
  host: string;
  port: number;
}

export interface SftpOptions {
  defaultPath: string;
  showHidden: boolean;
}

export type GroupInput = Pick<SessionGroup, "name" | "parentId">;

export type SessionInput = Omit<SessionConfig, "id" | "createdAt" | "updatedAt" | "favorite" | "lastConnectedAt">;

export interface TunnelConfig {
  id: string;
  name: string;
  sessionId: string;
  forwardType: "local" | "remote" | "dynamic";
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  createdAt: string;
  updatedAt: string;
}

export type TunnelInput = Omit<TunnelConfig, "id" | "createdAt" | "updatedAt">;

export interface ConnectionInfo {
  connectionId: string;
  sessionId: string;
  host: string;
  port: number;
  username: string;
  status: ConnectionState;
  connectedAt: string;
}

export interface TerminalInfo {
  terminalId: string;
  connectionId: string;
  cols: number;
  rows: number;
  openedAt: string;
}

export interface SftpInfo {
  sftpId: string;
  connectionId: string;
  openedAt: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitStatus?: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface TransferInfo {
  transferId: string;
  sessionId: string;
  sftpId: string;
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "canceled";
  bytesDone: number;
  bytesTotal: number;
  speedKbps: number;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransferHistorySnapshot {
  version: 1;
  savedAt: string;
  transfers: TransferInfo[];
}

export interface FileSaveRecord {
  id: string;
  sessionId?: string | null;
  path: string;
  directory: string;
  name: string;
  content: string;
  status: "saving" | "success" | "failed";
  error?: string | null;
  savedAt: string;
}

export interface TelemetryJobInfo {
  jobId: string;
  sessionId: string;
  intervalMs: number;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  startedAt: string;
}

export interface ForwardInfo {
  forwardId: string;
  sessionId: string;
  forwardType: "local" | "remote" | "dynamic";
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  startedAt: string;
  error?: string | null;
}

export interface ForwardStatusEvent extends ForwardInfo {}

export interface TerminalOutputEvent {
  terminalId: string;
  kind: "system" | "output" | "error";
  data: string;
  dataBase64?: string;
}

export interface TerminalClosedEvent {
  terminalId: string;
}

export interface AppInfo {
  version: string;
  os: string;
  arch: string;
  databasePath: string;
}

export interface UpdateAsset {
  name: string;
  downloadUrl: string;
  size: number;
  sha256?: string;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  tagName: string;
  htmlUrl: string;
  body: string;
  publishedAt: string;
  asset: UpdateAsset | null;
  hasUpdate: boolean;
  signatureVerified?: boolean;
}

export interface TelemetrySnapshotEvent {
  jobId: string;
  sessionId: string;
  snapshot: ServerTelemetry;
}

export interface HostKeyVerification {
  sessionId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  expectedFingerprint?: string | null;
}

export interface SftpChangedEvent {
  sftpId: string;
  path: string;
}
