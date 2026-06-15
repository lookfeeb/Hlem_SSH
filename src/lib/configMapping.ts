import { defaultSftpOptions, defaultSshOptions, defaultTerminalOptions, emptyPasswordAuth } from "../api/vaultApi";
import { unknownErrorMessage } from "./errors";
import { createEmptyTelemetry } from "./remoteDefaults";
import type { HostKeyVerification, RemoteSession, SessionConfig, SessionInput } from "../types";

const ACCENTS = ["#16a34a", "#2563eb", "#ea580c", "#0f766e", "#7c3aed"];

export function configToRemoteSession(config: SessionConfig, index: number): RemoteSession {
  return {
    id: config.id,
    name: config.name,
    groupId: config.groupId ?? null,
    host: config.host,
    username: config.username,
    state: "disconnected",
    accent: ACCENTS[index % ACCENTS.length],
    favorite: Boolean(config.favorite),
    lastConnectedAt: config.lastConnectedAt ?? null,
    currentPath: initialRemotePath(config.username, config.defaultPath || config.sftp.defaultPath),
    connectionId: null,
    connectedAt: null,
    sshVersion: null,
    terminalId: null,
    sftpId: null,
    telemetryJobId: null,
    terminal: [],
    telemetry: createEmptyTelemetry(config.host),
    files: [],
  };
}

export function defaultRemoteHomePath(username: string): string {
  const name = username.trim();
  if (!name || name === "root") return "/root";
  return `/home/${name}`;
}

export function initialRemotePath(username: string, configuredPath?: string | null): string {
  const path = configuredPath?.trim();
  if (!path || path === "/") return defaultRemoteHomePath(username);
  return path;
}

export function createDefaultSessionInput(groupId?: string | null): SessionInput {
  return {
    name: "",
    groupId: groupId ?? null,
    host: "",
    port: 22,
    username: "root",
    auth: emptyPasswordAuth(),
    ssh: defaultSshOptions(),
    defaultPath: "",
    tags: [],
    note: null,
    terminal: defaultTerminalOptions(),
    sftp: defaultSftpOptions(),
  };
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return normalizeErrorMessage(error.message);
  if (typeof error === "string") return normalizeErrorMessage(error);
  const payload = objectRecord(error);
  if (payload && "message" in payload) {
    if (isHostKeyErrorCode(payload.code) && payload.message && typeof payload.message === "object") {
      const hostKey = objectRecord(payload.message);
      if (hostKey) return `主机密钥需要确认：${hostKey.host ?? ""} ${hostKey.fingerprint ?? ""}`.trim();
    }
    return typeof payload.message === "string"
      ? normalizeErrorMessage(payload.message)
      : unknownErrorMessage(payload.message) || "操作失败";
  }
  return "操作失败";
}

export function getErrorCode(error: unknown): string | null {
  const code = objectRecord(error)?.code;
  return typeof code === "string" ? code : null;
}

export function getHostKeyPayload(error: unknown): HostKeyVerification | null {
  const payload = objectRecord(error);
  if (!payload || !isHostKeyErrorCode(payload.code)) return null;
  const message = objectRecord(payload.message);
  if (!message) return null;
  const sessionId = stringValue(message.sessionId);
  const host = stringValue(message.host);
  const port = typeof message.port === "number" && Number.isFinite(message.port) ? message.port : null;
  const algorithm = stringValue(message.algorithm);
  const fingerprint = stringValue(message.fingerprint);
  if (!sessionId || !host || port === null || !algorithm || !fingerprint) return null;
  const expectedFingerprint = stringValue(message.expectedFingerprint);
  return { sessionId, host, port, algorithm, fingerprint, expectedFingerprint };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isHostKeyErrorCode(value: unknown): boolean {
  return value === "hostKeyUntrusted" || value === "hostKeyChanged";
}

function normalizeErrorMessage(message: string) {
  if (message.includes("Failed to open channel") && message.includes("ConnectFailed")) {
    return "远端拒绝打开新的 SSH 通道（ConnectFailed）。SSH 登录可能成功了，但终端、SFTP 或 exec 通道被服务端限制。";
  }
  return message;
}
