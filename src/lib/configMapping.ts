import { defaultSftpOptions, defaultSshOptions, defaultTerminalOptions, emptyPasswordAuth } from "../api/vaultApi";
import { createEmptyTelemetry } from "./remoteDefaults";
import type { RemoteSession, SessionConfig, SessionInput } from "../types";

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

export function createDefaultSessionInput(index: number, groupId?: string | null): SessionInput {
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
  if (error && typeof error === "object" && "message" in error) {
    const payload = error as { code?: string; message: unknown };
    if ((payload.code === "hostKeyUntrusted" || payload.code === "hostKeyChanged") && typeof payload.message === "object") {
      const hostKey = payload.message as { host?: string; fingerprint?: string };
      return `主机密钥需要确认：${hostKey.host ?? ""} ${hostKey.fingerprint ?? ""}`.trim();
    }
    return typeof payload.message === "string" ? normalizeErrorMessage(payload.message) : JSON.stringify(payload.message);
  }
  return "操作失败";
}

export function getErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function normalizeErrorMessage(message: string) {
  if (message.includes("Failed to open channel") && message.includes("ConnectFailed")) {
    return "远端拒绝打开新的 SSH 通道（ConnectFailed）。SSH 登录可能成功了，但终端、SFTP 或 exec 通道被服务端限制。";
  }
  return message;
}
