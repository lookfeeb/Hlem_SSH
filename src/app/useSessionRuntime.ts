import { Modal } from "antd";
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { remoteApi } from "../api/remoteApi";
import { vaultApi } from "../api/vaultApi";
import { getErrorMessage, initialRemotePath } from "../lib/configMapping";
import { createEmptyTelemetry } from "../lib/remoteDefaults";
import { createTerminalEntry } from "../lib/session";
import {
  formatSessionError,
  getHostKeyPayload,
  notifyEditorSessionDisconnected,
  shouldSkipTerminalEntry,
} from "./appHelpers";
import type { ConfigSnapshot, RemoteSession } from "../types";

type TerminalInfo = { terminalId: string };

const SSH_VERSION_COMMAND =
  "sh -lc 'if command -v sshd >/dev/null 2>&1; then sshd -V 2>&1; elif [ -x /usr/sbin/sshd ]; then /usr/sbin/sshd -V 2>&1; elif [ -x /usr/local/sbin/sshd ]; then /usr/local/sbin/sshd -V 2>&1; else ssh -V 2>&1; fi'";

type UseSessionRuntimeOptions = {
  sessions: RemoteSession[];
  activeSession: RemoteSession | undefined;
  activeSessionId: string;
  setSessions: Dispatch<SetStateAction<RemoteSession[]>>;
  setOpenSessionIds: Dispatch<SetStateAction<string[]>>;
  setActiveSessionId: Dispatch<SetStateAction<string>>;
  updateSession: (sessionId: string, updater: (session: RemoteSession) => RemoteSession) => void;
  applySnapshot: (snapshot: ConfigSnapshot, preferredSessionId?: string, preserveRuntime?: boolean) => void;
  applyConfigSnapshot: (snapshot: ConfigSnapshot) => void;
  registerTerminal: (terminalId: string, sessionId: string) => void;
  consumePendingTerminalEntries: (terminalId: string) => RemoteSession["terminal"];
  appendTerminal: (sessionId: string, kind: "system" | "error", content: string) => void;
};

export function useSessionRuntime({
  sessions,
  activeSession,
  activeSessionId,
  setSessions,
  setOpenSessionIds,
  setActiveSessionId,
  updateSession,
  applySnapshot,
  applyConfigSnapshot,
  registerTerminal,
  consumePendingTerminalEntries,
  appendTerminal,
}: UseSessionRuntimeOptions) {
  const [connectingSessionId, setConnectingSessionId] = useState<string | null>(null);
  const pendingConnectionIdsRef = useRef<Map<string, string>>(new Map());
  const abortedConnectSessionsRef = useRef<Set<string>>(new Set());
  const uiInitiatedConnectsRef = useRef<Set<string>>(new Set());

  function resetSessionRuntime() {
    pendingConnectionIdsRef.current.clear();
    abortedConnectSessionsRef.current.clear();
    uiInitiatedConnectsRef.current.clear();
    setConnectingSessionId(null);
  }

  function activateSession(id: string) {
    setOpenSessionIds((current) => (current.includes(id) ? current : [...current, id]));
    setActiveSessionId(id);
  }

  async function deleteSession(id: string) {
    const session = sessions.find((item) => item.id === id);
    if (connectingSessionId === id) {
      await cancelConnectingSession(id);
    } else if (session?.connectionId) {
      await teardownSession(session).catch(() => undefined);
    }
    closeSessionTab(id);
    applySnapshot(await vaultApi.sessionDelete(id));
  }

  async function cancelConnectingSession(id: string) {
    if (connectingSessionId !== id) return;
    abortedConnectSessionsRef.current.add(id);
    const pendingConnectionId = pendingConnectionIdsRef.current.get(id);
    if (pendingConnectionId) {
      pendingConnectionIdsRef.current.delete(id);
      await remoteApi.disconnect(pendingConnectionId).catch(() => undefined);
    }
    setConnectingSessionId((current) => (current === id ? null : current));
    updateSession(id, (item) => ({
      ...item,
      state: "disconnected",
      connectionId: null,
      connectedAt: null,
      sshVersion: null,
      terminalId: null,
      sftpId: null,
      telemetryJobId: null,
    }));
  }

  async function closeSession(id: string) {
    const session = sessions.find((item) => item.id === id);
    if (connectingSessionId === id) {
      await cancelConnectingSession(id);
    } else if (session?.connectionId) {
      await teardownSession(session);
    }
    resetClosedSessionState(id);
    closeSessionTab(id);
  }

  function closeSessionTab(id: string) {
    setOpenSessionIds((current) => {
      const nextIds = current.filter((item) => item !== id);
      if (activeSessionId === id) setActiveSessionId(nextIds[0] ?? "");
      return nextIds;
    });
  }

  async function disconnectSession(session = activeSession) {
    if (!session?.connectionId) return;
    await teardownSession(session);
  }

  async function teardownSession(session: RemoteSession) {
    if (!session.connectionId) return;
    try {
      await remoteApi.disconnect(session.connectionId);
      updateSession(session.id, (item) => ({
        ...item,
        state: "disconnected",
        connectionId: null,
        connectedAt: null,
        sshVersion: null,
        terminalId: null,
        sftpId: null,
        telemetryJobId: null,
        telemetry: createEmptyTelemetry(item.host),
        files: [],
        terminal: appendDisconnectedTerminalEntry(item.terminal),
      }));
      notifyEditorSessionDisconnected(session.id);
    } catch (error) {
      appendTerminal(session.id, "error", formatSessionError(error, session));
    }
  }

  function resetClosedSessionState(id: string) {
    updateSession(id, (item) => ({
      ...item,
      state: "disconnected",
      connectionId: null,
      connectedAt: null,
      sshVersion: null,
      terminalId: null,
      sftpId: null,
      telemetryJobId: null,
      files: [],
      terminal: [],
      telemetry: createEmptyTelemetry(item.host),
    }));
  }

  function handleSshStatus(payload: Awaited<ReturnType<typeof remoteApi.connect>>) {
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== payload.sessionId) return session;
        if (payload.status === "disconnected") {
          notifyEditorSessionDisconnected(session.id);
          return {
            ...session,
            state: "disconnected",
            connectionId: null,
            connectedAt: null,
            sshVersion: null,
            terminalId: null,
            sftpId: null,
            telemetryJobId: null,
            files: [],
            telemetry: createEmptyTelemetry(session.host),
            terminal:
              session.state === "disconnected"
                ? session.terminal
                : appendDisconnectedTerminalEntry(session.terminal),
          };
        }
        if (
          payload.status === "connected" &&
          !uiInitiatedConnectsRef.current.has(session.id) &&
          !session.terminalId
        ) {
          void backfillExternalConnection(session.id, payload.connectionId);
        }
        if (payload.status === "connected" && !uiInitiatedConnectsRef.current.has(session.id) && !session.sshVersion) {
          void fetchSshVersion(payload.connectionId, session.id);
        }
        return {
          ...session,
          state: payload.status,
          connectionId: payload.connectionId,
          connectedAt: payload.status === "connected" ? payload.connectedAt : session.connectedAt,
        };
      }),
    );
  }

  async function backfillExternalConnection(
    sessionId: string,
    connectionId: string,
  ) {
    if (uiInitiatedConnectsRef.current.has(sessionId)) return;
    try {
      const terminal = await remoteApi.openTerminal(connectionId, 100, 30);
      registerTerminal(terminal.terminalId, sessionId);
      updateSession(sessionId, (item) => ({ ...item, terminalId: terminal.terminalId }));
    } catch (error) {
      appendTerminal(sessionId, "error", `终端不可用：${getErrorMessage(error)}`);
    }
    startTelemetry(connectionId, sessionId);
    void fetchSshVersion(connectionId, sessionId);
  }

  async function connectSession(session = activeSession) {
    if (!session || connectingSessionId === session.id) return;
    abortedConnectSessionsRef.current.delete(session.id);
    uiInitiatedConnectsRef.current.add(session.id);
    setConnectingSessionId(session.id);
    updateSession(session.id, (item) => ({
      ...item,
      state: "connecting",
      connectionId: null,
      connectedAt: null,
      sshVersion: null,
      terminalId: null,
      sftpId: null,
      telemetryJobId: null,
      files: [],
    }));
    let connection: Awaited<ReturnType<typeof remoteApi.connect>> | null = null;
    try {
      connection = await remoteApi.connect(session.id);
      const connectionId = connection.connectionId;
      pendingConnectionIdsRef.current.set(session.id, connectionId);
      if (await disconnectIfAborted(session.id, connectionId)) return;

      const initialPath = initialRemotePath(session.username, session.currentPath);
      const terminalResult = await openTerminalSafely(connectionId);
      if (await disconnectIfAborted(session.id, connectionId)) return;

      const terminal = terminalResult.value;
      if (terminal) attachTerminal(session.id, terminal);

      pendingConnectionIdsRef.current.delete(session.id);
      updateSession(session.id, (item) => ({
        ...item,
        state: "connected",
        currentPath: initialPath,
        connectionId,
        connectedAt: connection?.connectedAt ?? new Date().toISOString(),
        terminalId: terminal?.terminalId ?? null,
        sftpId: null,
        telemetryJobId: null,
        files: [],
        terminal: [
          ...item.terminal,
          ...(terminalResult.error ? [createTerminalEntry("error", `终端不可用：${getErrorMessage(terminalResult.error)}`)] : []),
        ],
      }));
      setConnectingSessionId(null);
      startTelemetry(connectionId, session.id);
      void fetchSshVersion(connectionId, session.id);

      if (!terminal) throw new Error("SSH 已连接，但远端拒绝打开终端通道");
    } catch (error) {
      if (connection?.connectionId) {
        await remoteApi.disconnect(connection.connectionId).catch(() => undefined);
      }
      pendingConnectionIdsRef.current.delete(session.id);
      if (abortedConnectSessionsRef.current.has(session.id)) return;
      updateSession(session.id, (item) => ({ ...item, state: "failed" }));
      const hostKey = getHostKeyPayload(error);
      if (hostKey) {
        Modal.confirm({
          title: hostKey.expectedFingerprint ? "主机密钥已变化" : "确认主机密钥",
          content: `${hostKey.host}:${hostKey.port} ${hostKey.algorithm} ${hostKey.fingerprint}`,
          okText: "信任并连接",
          cancelText: "取消",
          onOk: async () => {
            applyConfigSnapshot(await remoteApi.trustHostKey(hostKey.sessionId, hostKey.algorithm, hostKey.fingerprint));
            await connectSession(session);
          },
        });
      } else {
        appendTerminal(session.id, "error", formatSessionError(error, session));
      }
    } finally {
      abortedConnectSessionsRef.current.delete(session.id);
      uiInitiatedConnectsRef.current.delete(session.id);
      setConnectingSessionId((current) => (current === session.id ? null : current));
    }
  }

  async function disconnectIfAborted(sessionId: string, connectionId: string) {
    if (!abortedConnectSessionsRef.current.has(sessionId)) return false;
    pendingConnectionIdsRef.current.delete(sessionId);
    await remoteApi.disconnect(connectionId).catch(() => undefined);
    return true;
  }

  async function openTerminalSafely(connectionId: string): Promise<{ value: TerminalInfo | null; error: unknown }> {
    return remoteApi
      .openTerminal(connectionId, 100, 30)
      .then((value) => ({ value, error: null }))
      .catch((error: unknown) => ({ value: null, error }));
  }

  function attachTerminal(sessionId: string, terminal: TerminalInfo) {
    registerTerminal(terminal.terminalId, sessionId);
    const pendingTerminalEntries = consumePendingTerminalEntries(terminal.terminalId);
    if (pendingTerminalEntries.length) {
      updateSession(sessionId, (item) => ({ ...item, terminal: [...item.terminal, ...pendingTerminalEntries] }));
    }
  }

  function startTelemetry(connectionId: string, sessionId: string) {
    remoteApi
      .startTelemetry(connectionId, sessionId, 5000)
      .then((telemetryJob) => {
        if (abortedConnectSessionsRef.current.has(sessionId)) return;
        updateSession(sessionId, (item) =>
          item.connectionId === connectionId
            ? {
                ...item,
                telemetryJobId: telemetryJob?.jobId ?? item.telemetryJobId,
              }
            : item,
        );
      })
      .catch(() => null);
  }

  function fetchSshVersion(connectionId: string, sessionId: string) {
    remoteApi
      .execOnConnection(connectionId, SSH_VERSION_COMMAND, 3000)
      .then((result) => {
        const sshVersion = normalizeSshVersion(`${result.stdout}\n${result.stderr}`);
        if (!sshVersion) return;
        updateSession(sessionId, (item) =>
          item.connectionId === connectionId
            ? {
                ...item,
                sshVersion,
              }
            : item,
        );
      })
      .catch(() => undefined);
  }

  function appendDisconnectedTerminalEntry(entries: RemoteSession["terminal"]) {
    const entry = createTerminalEntry("system", "连接已断开");
    return shouldSkipTerminalEntry(entries, entry) ? entries : [...entries, entry];
  }

  return {
    connectingSessionId,
    resetSessionRuntime,
    activateSession,
    deleteSession,
    cancelConnectingSession,
    closeSession,
    disconnectSession,
    handleSshStatus,
    connectSession,
  };
}

function normalizeSshVersion(output: string) {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && /(OpenSSH|Dropbear|SSH)/i.test(item));
  if (!line) return "";

  const openSsh = line.match(/OpenSSH[_\s-]?([^\s,]+)/i);
  if (openSsh) return `OpenSSH ${openSsh[1]}`;

  const dropbear = line.match(/Dropbear[_\s-]?([^\s,]+)/i);
  if (dropbear) return `Dropbear ${dropbear[1]}`;

  return line.replace(/^SSH-[\d.]+-/, "").split(",")[0].replace(/_/g, " ");
}
