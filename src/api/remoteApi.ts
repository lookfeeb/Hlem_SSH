import type {
  ConfigSnapshot,
  ConnectionInfo,
  ExecResult,
  ForwardInfo,
  ForwardStatusEvent,
  HostKeyVerification,
  LatencyProbeResult,
  RemoteFileEntry,
  ServerTelemetry,
  SftpChangedEvent,
  SftpInfo,
  TelemetryJobInfo,
  TerminalClosedEvent,
  TelemetrySnapshotEvent,
  TerminalInfo,
  TerminalOutputEvent,
  TransferHistorySnapshot,
  TransferInfo,
} from "../types";
import { call, listenEvent } from "./bridge";

const EVENT_NAMES = {
  sshStatus: "ssh://status",
  terminalOutput: "terminal://output",
  terminalClosed: "terminal://closed",
  sftpChanged: "sftp://changed",
  telemetrySnapshot: "telemetry://snapshot",
  transferProgress: "transfer://progress",
  transferCompleted: "transfer://completed",
  transferFailed: "transfer://failed",
  hostKeyVerify: "host-key://verify",
  forwardStatus: "forward://status",
} as const;

export const remoteApi = {
  connect: (sessionId: string) => call<ConnectionInfo>("ssh_connect", { sessionId }),
  disconnect: (connectionId: string) => call<void>("ssh_disconnect", { connectionId }),
  trustHostKey: (sessionId: string, algorithm: string, fingerprint: string) =>
    call<ConfigSnapshot>("ssh_trust_host_key", { sessionId, algorithm, fingerprint }),
  openTerminal: (connectionId: string, cols = 100, rows = 30) =>
    call<TerminalInfo>("terminal_open", { connectionId, cols, rows }),
  startTerminal: (terminalId: string) => call<void>("terminal_start", { terminalId }),
  writeTerminal: (terminalId: string, data: string) => call<void>("terminal_write", { terminalId, data }),
  resizeTerminal: (terminalId: string, cols: number, rows: number) =>
    call<void>("terminal_resize", { terminalId, cols, rows }),
  closeTerminal: (terminalId: string) => call<void>("terminal_close", { terminalId }),
  exec: (sessionId: string, command: string, timeoutMs = 20000) =>
    call<ExecResult>("ssh_exec", { sessionId, command, timeoutMs }),
  execOnConnection: (connectionId: string, command: string, timeoutMs = 20000) =>
    call<ExecResult>("ssh_exec_on_connection", {
      connectionId,
      command,
      timeoutMs,
    }),
  openSftp: (connectionId: string) => call<SftpInfo>("sftp_open", { connectionId }),
  closeSftp: (sftpId: string) => call<void>("sftp_close", { sftpId }),
  listFiles: (sftpId: string, path: string) =>
    call<RemoteFileEntry[]>("sftp_list", { sftpId, path }, { retries: 1 }),
  searchFile: (sftpId: string, basePath: string, query: string) =>
    call<string | null>("sftp_search", { sftpId, basePath, query }, { timeoutMs: 5 * 60_000 }),
  mkdir: (sftpId: string, path: string) => call<void>("sftp_mkdir", { sftpId, path }),
  createFile: (sftpId: string, path: string) => call<void>("sftp_create_file", { sftpId, path }),
  delete: (sftpId: string, path: string, recursive = false) =>
    call<void>("sftp_delete", { sftpId, path, recursive }),
  rename: (sftpId: string, from: string, to: string) => call<void>("sftp_rename", { sftpId, from, to }),
  copy: (sftpId: string, from: string, to: string) => call<void>("sftp_copy", { sftpId, from, to }),
  pathExists: (sftpId: string, path: string) => call<boolean>("sftp_exists", { sftpId, path }),
  readText: (sftpId: string, path: string) => call<string>("sftp_read_text", { sftpId, path }, { timeoutMs: 5 * 60_000 }),
  writeText: (sftpId: string, path: string, content: string) =>
    call<void>("sftp_write_text", { sftpId, path, content }, { timeoutMs: 5 * 60_000 }),
  resolveTarget: (sftpId: string, currentPath: string, sourcePath: string, value: string) =>
    call<string>("sftp_resolve_target", { sftpId, currentPath, sourcePath, value }),
  upload: (
    sftpId: string,
    localPath: string,
    remotePath: string,
    overwrite = false,
    accelerated = false,
    resume = false,
  ) =>
    call<TransferInfo>("transfer_upload", {
      input: {
        sftpId,
        localPath,
        remotePath,
        overwrite,
        accelerated,
        resume,
      },
    }),
  download: (sftpId: string, remotePath: string, localPath: string, overwrite = false) =>
    call<TransferInfo>("transfer_download", {
      sftpId,
      remotePath,
      localPath,
      overwrite,
    }),
  cancelTransfer: (transferId: string) => call<void>("transfer_cancel", { transferId }),
  pauseTransfer: (transferId: string) => call<TransferInfo>("transfer_pause", { transferId }),
  resumeTransfer: (transferId: string) => call<TransferInfo>("transfer_resume", { transferId }),
  removeTransfer: (transferId: string) => call<TransferHistorySnapshot>("transfer_remove", { transferId }),
  retryTransfer: (transferId: string) => call<TransferInfo>("transfer_retry", { transferId }),
  transferHistorySnapshot: () => call<TransferHistorySnapshot>("transfer_history_snapshot", undefined, { retries: 1 }),
  clearFinishedTransferHistory: () => call<TransferHistorySnapshot>("transfer_history_clear_finished"),
  startTelemetry: (connectionId: string, sessionId: string, intervalMs = 5000) =>
    call<TelemetryJobInfo>("telemetry_start", { connectionId, sessionId, intervalMs }),
  stopTelemetry: (jobId: string) => call<void>("telemetry_stop", { jobId }),
  telemetrySnapshot: (connectionId: string) =>
    call<ServerTelemetry>("telemetry_snapshot", { connectionId }, { retries: 1, timeoutMs: 45_000 }),
  probeLatency: (connectionId: string, samples = 5) =>
    call<LatencyProbeResult>("latency_probe", { connectionId, samples }, { timeoutMs: 30_000 }),
  startLocalForward: (
    sessionId: string,
    bindHost: string,
    bindPort: number,
    remoteHost: string,
    remotePort: number,
  ) =>
    call<ForwardInfo>("forward_start_local", { sessionId, bindHost, bindPort, remoteHost, remotePort }),
  startRemoteForward: (
    sessionId: string,
    remoteBindHost: string,
    remoteBindPort: number,
    localHost: string,
    localPort: number,
  ) =>
    call<ForwardInfo>("forward_start_remote", { sessionId, remoteBindHost, remoteBindPort, localHost, localPort }),
  startDynamicForward: (sessionId: string, bindHost: string, bindPort: number) =>
    call<ForwardInfo>("forward_start_dynamic", {
      sessionId,
      bindHost,
      bindPort,
    }),
  stopForward: (forwardId: string) => call<void>("forward_stop", { forwardId }),
  listForwards: () => call<ForwardInfo[]>("forward_list", undefined, { retries: 1 }),
  onForwardStatus: (handler: (payload: ForwardStatusEvent) => void) => listenEvent(EVENT_NAMES.forwardStatus, handler),
  onSshStatus: (handler: (payload: ConnectionInfo) => void) => listenEvent(EVENT_NAMES.sshStatus, handler),
  onSftpChanged: (handler: (payload: SftpChangedEvent) => void) => listenEvent(EVENT_NAMES.sftpChanged, handler),
  onTerminalOutput: (handler: (payload: TerminalOutputEvent) => void) => listenEvent(EVENT_NAMES.terminalOutput, handler),
  onTerminalClosed: (handler: (payload: TerminalClosedEvent) => void) => listenEvent(EVENT_NAMES.terminalClosed, handler),
  onTelemetrySnapshot: (handler: (payload: TelemetrySnapshotEvent) => void) =>
    listenEvent(EVENT_NAMES.telemetrySnapshot, handler),
  onTransferProgress: (handler: (payload: TransferInfo) => void) => listenEvent(EVENT_NAMES.transferProgress, handler),
  onTransferCompleted: (handler: (payload: TransferInfo) => void) => listenEvent(EVENT_NAMES.transferCompleted, handler),
  onTransferFailed: (handler: (payload: TransferInfo) => void) => listenEvent(EVENT_NAMES.transferFailed, handler),
  onHostKeyVerify: (handler: (payload: HostKeyVerification) => void) => listenEvent(EVENT_NAMES.hostKeyVerify, handler),
};
