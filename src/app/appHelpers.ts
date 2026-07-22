import { defaultRemoteHomePath, getErrorMessage, initialRemotePath } from "../lib/configMapping";
import { EDITOR_CHANNEL_NAME, type EditorChannelMessage } from "../lib/editorChannel";
import { normalizePath as normalizeRemotePath } from "../lib/path";
import type { RemoteSession, SessionConfig, SessionInput, TerminalEntry } from "../types";

export { getHostKeyPayload } from "../lib/configMapping";

const CWD_TRACKING_ECHO_FRAGMENTS = [
  "HELM_CWD_HOOK",
  "__helm_emit_cwd",
  "777;cwd",
  "PROMPT_COMMAND",
  "add-zsh-hook precmd",
  "precmd_functions",
];

export function sessionConfigToInput(config: SessionConfig): SessionInput {
  return {
    name: config.name,
    groupId: config.groupId ?? null,
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    ssh: config.ssh,
    defaultPath: config.defaultPath,
    tags: config.tags,
    note: config.note ?? null,
    terminal: config.terminal,
    sftp: config.sftp,
  };
}

export function createNextSessionName(sessions: SessionConfig[], excludeId?: string) {
  const usedNames = new Set(sessions.filter((session) => session.id !== excludeId).map((session) => session.name));
  let index = 1;
  while (usedNames.has(`新服务器 ${index}`)) index += 1;
  return `新服务器 ${index}`;
}

export function shouldSkipTerminalEntry(entries: TerminalEntry[], entry: TerminalEntry) {
  const last = entries[entries.length - 1];
  if (entry.kind === "output") return false;
  return Boolean(last && last.kind === entry.kind && last.content === entry.content);
}

export async function runUploadQueue<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  worker: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = [];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(12, concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        results.push(await worker(item));
      }
    }),
  );
  return results;
}

export function uploadConcurrency(count: number) {
  const cores = typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency || 4;
  if (count <= 1) return 1;
  if (count <= 3) return Math.min(count, 2);
  if (count <= 8) return Math.min(count, Math.max(2, Math.floor(cores / 2)));
  return Math.min(12, Math.max(4, Math.floor(cores * 0.75)));
}

export function stripCwdMarkers(data: string) {
  let cwd: string | null = null;
  const withoutMarkers = data.replace(/\x1b\]777;cwd=([^\x07]*)\x07/g, (_, value: string) => {
    cwd = value;
    return "";
  });
  const withoutCommandEcho = withoutMarkers
    .split(/(\r?\n)/)
    .filter((chunk) => !CWD_TRACKING_ECHO_FRAGMENTS.some((fragment) => chunk.includes(fragment)))
    .join("");
  return { data: withoutCommandEcho, cwd };
}

export function extractPromptCwd(data: string, username: string, loginPath?: string | null) {
  const cleaned = stripTerminalControls(data).replace(/\r/g, "\n");
  const lines = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-8)
    .reverse();
  for (const line of lines) {
    const cwd = extractPromptCwdFromLine(line);
    if (!cwd) continue;
    const path = resolvePromptCwd(cwd, username, loginPath);
    if (path) return path;
  }
  return null;
}

function extractPromptCwdFromLine(line: string) {
  const plainPrompt = line.match(/(?:^|\s)[\w.-]+@[\w.-]+:(.+?)(?:[$#>])\s*$/);
  if (plainPrompt?.[1]) return plainPrompt[1].trim();
  const bracketPrompt = line.match(/(?:^|\s)\[[^\]\s]+@[\w.-]+\s+(.+?)\](?:[$#>])\s*$/);
  if (bracketPrompt?.[1]) return bracketPrompt[1].trim();
  return null;
}

function resolvePromptCwd(cwd: string, username: string, loginPath?: string | null) {
  const homePath = loginPath ? normalizeRemotePath(loginPath) : defaultRemoteHomePath(username);
  if (cwd === "~") return homePath;
  if (cwd.startsWith("~/")) return `${homePath}${cwd.slice(1)}`;
  if (cwd.startsWith("/")) return cwd;
  return null;
}

function stripTerminalControls(value: string) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function remoteSessionPath(session: Pick<RemoteSession, "username" | "currentPath">) {
  const path = session.currentPath.trim();
  return path ? normalizeRemotePath(path) : initialRemotePath(session.username, null);
}

export function sftpUnavailableMessage(error: unknown) {
  const message = getErrorMessage(error);
  if (!message.includes("ConnectFailed")) return message;
  return `${message} 建议在服务器 /etc/ssh/sshd_config 中提高 MaxSessions（例如 10），确认 Subsystem sftp 已启用，然后重启 sshd。`;
}

export function formatSessionError(
  error: unknown,
  session: Pick<RemoteSession, "name" | "connectionId" | "terminalId" | "sftpId">,
): string {
  let message = getErrorMessage(error);
  for (const id of [session.connectionId, session.terminalId, session.sftpId]) {
    if (id) message = message.split(id).join(session.name);
  }
  return message;
}

export function notifyEditorSessionDisconnected(sessionId: string) {
  const channel = new BroadcastChannel(EDITOR_CHANNEL_NAME);
  try {
    channel.postMessage({ type: "sessionDisconnected", sessionId } satisfies EditorChannelMessage);
  } catch (error) {
    console.warn("[helm] failed to notify editor session disconnect:", getErrorMessage(error));
  } finally {
    channel.close();
  }
}

export function notifyEditorSessionReconnected(sessionId: string) {
  const channel = new BroadcastChannel(EDITOR_CHANNEL_NAME);
  try {
    channel.postMessage({ type: "sessionReconnected", sessionId } satisfies EditorChannelMessage);
  } catch (error) {
    console.warn("[helm] failed to notify editor session reconnect:", getErrorMessage(error));
  } finally {
    channel.close();
  }
}
