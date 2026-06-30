import { Modal } from "antd";
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { remoteApi } from "../api/remoteApi";
import { vaultApi } from "../api/vaultApi";
import { getErrorMessage, initialRemotePath } from "../lib/configMapping";
import { normalizePath as normalizeRemotePath } from "../lib/path";
import { useMountedRef } from "../lib/reactLifecycle";
import { createEmptyTelemetry } from "../lib/remoteDefaults";
import { createTerminalEntry, isRuntimeSession, remoteSessionConfigId } from "../lib/session";
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
const LOGIN_PATH_COMMAND = "sh -lc 'pwd -P 2>/dev/null || pwd'";
const LOGIN_PATH_TIMEOUT_MS = 5000;

type ConnectionPaths = {
  initialPath: string;
  loginPath: string;
};

function hasConfiguredInitialPath(path: string | null | undefined) {
  const value = path?.trim();
  return Boolean(value && value !== "/");
}

function firstAbsoluteRemotePath(stdout: string) {
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith("/"));
  if (!line || line.includes("\0")) return null;
  return normalizeRemotePath(line);
}

async function resolveRemoteLoginPath(connectionId: string) {
  try {
    const result = await remoteApi.execOnConnection(connectionId, LOGIN_PATH_COMMAND, LOGIN_PATH_TIMEOUT_MS);
    if (result.timedOut || (typeof result.exitStatus === "number" && result.exitStatus !== 0)) return null;
    return firstAbsoluteRemotePath(result.stdout);
  } catch (error) {
    console.warn("[helm] failed to resolve remote login path:", getErrorMessage(error));
    return null;
  }
}

async function resolveConnectionPaths(
  connectionId: string,
  username: string,
  configuredPath: string | null | undefined,
): Promise<ConnectionPaths> {
  const fallbackLoginPath = initialRemotePath(username, null);
  const loginPath = (await resolveRemoteLoginPath(connectionId)) ?? fallbackLoginPath;
  return {
    initialPath: hasConfiguredInitialPath(configuredPath) ? initialRemotePath(username, configuredPath) : loginPath,
    loginPath,
  };
}

function createRuntimeSessionInstance(session: RemoteSession): RemoteSession {
  const configId = remoteSessionConfigId(session);
  return {
    ...session,
    id: `${configId}::instance::${crypto.randomUUID()}`,
    configId,
    state: "disconnected",
    connectionId: null,
    connectedAt: null,
    sshVersion: null,
    terminalId: null,
    sftpId: null,
    telemetryJobId: null,
    loginPath: null,
    terminal: [],
    telemetry: createEmptyTelemetry(session.host),
    files: [],
  };
}

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
  appendTerminal: (sessionId: string, kind: "system" | "error", content: string) => void;
  getSessionConfiguredPath: (sessionId: string) => string | null | undefined;
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
  appendTerminal,
  getSessionConfiguredPath,
}: UseSessionRuntimeOptions) {
  const [connectingSessionId, setConnectingSessionId] = useState<string | null>(null);
  const mountedRef = useMountedRef();
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

  function runtimeSessionsForConfig(configId: string) {
    return sessions.filter((session) => remoteSessionConfigId(session) === configId && isRuntimeSession(session));
  }

  async function deleteSession(id: string) {
    const configId = id;
    const baseSession = sessions.find((session) => session.id === configId);
    const runtimeSessions = runtimeSessionsForConfig(configId);
    const connectingRuntime = runtimeSessions.find((session) => session.id === connectingSessionId);
    if (connectingRuntime) {
      await cancelConnectingSession(connectingRuntime.id);
    }
    if (baseSession?.connectionId) {
      await teardownSession(baseSession);
    }
    for (const runtime of runtimeSessions) {
      if (runtime.connectionId) await teardownSession(runtime);
    }
    if (!mountedRef.current) return;
    closeSessionTabs([configId, ...runtimeSessions.map((session) => session.id)]);
    const snapshot = await vaultApi.sessionDelete(configId);
    if (mountedRef.current) applySnapshot(snapshot);
  }

  async function cancelConnectingSession(id: string) {
    const targetId = connectingSessionId === id
      ? id
      : sessions.find((session) => remoteSessionConfigId(session) === id && session.id === connectingSessionId)?.id;
    if (!targetId) return;
    abortedConnectSessionsRef.current.add(targetId);
    const pendingConnectionId = pendingConnectionIdsRef.current.get(targetId);
    if (pendingConnectionId) {
      pendingConnectionIdsRef.current.delete(targetId);
      await disconnectQuietly(pendingConnectionId, "cancel connecting session");
    }
    if (!mountedRef.current) return;
    setConnectingSessionId((current) => (current === targetId ? null : current));
    updateSession(targetId, (item) => ({
      ...item,
      state: "disconnected",
      connectionId: null,
      connectedAt: null,
      sshVersion: null,
      terminalId: null,
      sftpId: null,
      telemetryJobId: null,
      loginPath: null,
    }));
  }

  async function closeSession(id: string) {
    const session = sessions.find((item) => item.id === id);
    if (connectingSessionId === id) {
      await cancelConnectingSession(id);
    } else if (session?.connectionId) {
      await teardownSession(session);
    }
    if (!mountedRef.current) return;
    if (session && isRuntimeSession(session)) {
      removeRuntimeSession(id);
    } else {
      resetClosedSessionState(id);
    }
    closeSessionTab(id);
  }

  function closeSessionTab(id: string) {
    closeSessionTabs([id]);
  }

  function closeSessionTabs(ids: string[]) {
    const idSet = new Set(ids);
    setOpenSessionIds((current) => {
      const nextIds = current.filter((item) => !idSet.has(item));
      if (idSet.has(activeSessionId)) setActiveSessionId(nextIds[0] ?? "");
      return nextIds;
    });
  }

  function removeRuntimeSession(id: string) {
    setSessions((current) => current.filter((session) => session.id !== id));
  }

  async function disconnectSession(session = activeSession) {
    if (!session) return;
    const runtime = resolveDisconnectTarget(session);
    if (!runtime?.connectionId) return;
    await teardownSession(runtime);
  }

  function resolveDisconnectTarget(session: RemoteSession) {
    if (isRuntimeSession(session)) return session;
    if (session.connectionId) {
      return sessions.find((item) => item.connectionId === session.connectionId) ?? session;
    }
    return runtimeSessionsForConfig(remoteSessionConfigId(session)).find((item) => item.state === "connected" || item.connectionId);
  }

  async function teardownSession(session: RemoteSession) {
    if (!session.connectionId) return;
    try {
      await remoteApi.disconnect(session.connectionId);
      if (!mountedRef.current) return;
      updateSession(session.id, (item) => ({
        ...item,
        state: "disconnected",
        connectionId: null,
        connectedAt: null,
        sshVersion: null,
        terminalId: null,
        sftpId: null,
        telemetryJobId: null,
        loginPath: null,
        telemetry: createEmptyTelemetry(item.host),
        files: [],
        terminal: appendDisconnectedTerminalEntry(item.terminal),
      }));
      notifyEditorSessionDisconnected(session.id);
    } catch (error) {
      if (mountedRef.current) appendTerminal(session.id, "error", formatSessionError(error, session));
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
      loginPath: null,
      files: [],
      terminal: [],
      telemetry: createEmptyTelemetry(item.host),
    }));
  }

  function handleSshStatus(payload: Awaited<ReturnType<typeof remoteApi.connect>>) {
    if (!mountedRef.current) return;
    setSessions((current) =>
      current.map((session) => {
        const matchesConnection = Boolean(session.connectionId && session.connectionId === payload.connectionId);
        const matchesConfig = session.id === payload.sessionId && !isRuntimeSession(session);
        const uiManaged = current.some((item) => remoteSessionConfigId(item) === payload.sessionId && uiInitiatedConnectsRef.current.has(item.id));
        if (!matchesConnection && (!matchesConfig || uiManaged)) return session;
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
            loginPath: null,
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
      const session = sessions.find((item) => item.id === sessionId);
      const paths = session ? await resolveConnectionPaths(connectionId, session.username, getSessionConfiguredPath(sessionId)) : null;
      const terminal = await remoteApi.openTerminal(connectionId, 100, 30);
      if (!mountedRef.current) {
        await closeTerminalQuietly(terminal.terminalId, "unmounted external connection backfill");
        return;
      }
      registerTerminal(terminal.terminalId, sessionId);
      updateSession(sessionId, (item) => ({
        ...item,
        ...(paths ? { currentPath: paths.initialPath, loginPath: paths.loginPath } : {}),
        terminalId: terminal.terminalId,
      }));
    } catch (error) {
      if (mountedRef.current) appendTerminal(sessionId, "error", `终端不可用：${getErrorMessage(error)}`);
    }
    if (!mountedRef.current) return;
    startTelemetry(connectionId, sessionId);
    void fetchSshVersion(connectionId, sessionId);
  }

  async function connectSession(session = activeSession) {
    if (!mountedRef.current || !session) return;
    const targetSession = isRuntimeSession(session) ? session : createRuntimeSessionInstance(session);
    const runtimeId = targetSession.id;
    const configId = remoteSessionConfigId(targetSession);
    if (connectingSessionId === runtimeId) return;
    if (!isRuntimeSession(session)) {
      setSessions((current) => current.some((item) => item.id === runtimeId) ? current : [...current, targetSession]);
    }
    activateSession(runtimeId);
    abortedConnectSessionsRef.current.delete(runtimeId);
    uiInitiatedConnectsRef.current.add(runtimeId);
    setConnectingSessionId(runtimeId);
    updateSession(runtimeId, (item) => ({
      ...item,
      state: "connecting",
      connectionId: null,
      connectedAt: null,
      sshVersion: null,
      terminalId: null,
      sftpId: null,
      telemetryJobId: null,
      loginPath: null,
      files: [],
    }));
    let connection: Awaited<ReturnType<typeof remoteApi.connect>> | null = null;
    try {
      connection = await remoteApi.connect(configId);
      const connectionId = connection.connectionId;
      pendingConnectionIdsRef.current.set(runtimeId, connectionId);
      if (!mountedRef.current) {
        pendingConnectionIdsRef.current.delete(runtimeId);
        await disconnectQuietly(connectionId, "unmounted connect session cleanup");
        return;
      }
      if (await disconnectIfAborted(runtimeId, connectionId)) return;

      const paths = await resolveConnectionPaths(connectionId, targetSession.username, getSessionConfiguredPath(configId));
      if (!mountedRef.current) {
        pendingConnectionIdsRef.current.delete(runtimeId);
        await disconnectQuietly(connectionId, "unmounted connect session cleanup");
        return;
      }
      if (await disconnectIfAborted(runtimeId, connectionId)) return;

      const terminalResult = await openTerminalSafely(connectionId);
      if (!mountedRef.current) {
        pendingConnectionIdsRef.current.delete(runtimeId);
        await disconnectQuietly(connectionId, "unmounted connect session cleanup");
        return;
      }
      if (await disconnectIfAborted(runtimeId, connectionId)) return;

      const terminal = terminalResult.value;
      if (terminal) attachTerminal(runtimeId, terminal);

      pendingConnectionIdsRef.current.delete(runtimeId);
      if (!mountedRef.current) return;
      updateSession(runtimeId, (item) => ({
        ...item,
        state: "connected",
        currentPath: paths.initialPath,
        loginPath: paths.loginPath,
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
      startTelemetry(connectionId, runtimeId);
      void fetchSshVersion(connectionId, runtimeId);

      if (!terminal) throw new Error("SSH 已连接，但远端拒绝打开终端通道");
    } catch (error) {
      if (connection?.connectionId) {
        await disconnectQuietly(connection.connectionId, "connect session rollback");
      }
      pendingConnectionIdsRef.current.delete(runtimeId);
      if (abortedConnectSessionsRef.current.has(runtimeId)) return;
      if (!mountedRef.current) return;
      updateSession(runtimeId, (item) => ({ ...item, state: "failed" }));
      const hostKey = getHostKeyPayload(error);
      if (hostKey) {
        Modal.confirm({
          title: hostKey.expectedFingerprint ? "主机密钥已变化" : "确认主机密钥",
          content: `${hostKey.host}:${hostKey.port} ${hostKey.algorithm} ${hostKey.fingerprint}`,
          okText: "信任并连接",
          cancelText: "取消",
          onOk: async () => {
            const snapshot = await remoteApi.trustHostKey(hostKey.sessionId, hostKey.algorithm, hostKey.fingerprint);
            if (!mountedRef.current) return;
            applyConfigSnapshot(snapshot);
            await connectSession(targetSession);
          },
        });
      } else {
        appendTerminal(runtimeId, "error", formatSessionError(error, targetSession));
      }
    } finally {
      abortedConnectSessionsRef.current.delete(runtimeId);
      uiInitiatedConnectsRef.current.delete(runtimeId);
      if (mountedRef.current) setConnectingSessionId((current) => (current === runtimeId ? null : current));
    }
  }

  async function disconnectIfAborted(sessionId: string, connectionId: string) {
    if (!abortedConnectSessionsRef.current.has(sessionId)) return false;
    pendingConnectionIdsRef.current.delete(sessionId);
    await disconnectQuietly(connectionId, "aborted connection cleanup");
    return true;
  }

  async function disconnectQuietly(connectionId: string, context: string) {
    try {
      await remoteApi.disconnect(connectionId);
    } catch (error) {
      console.warn(`[helm] failed to disconnect during ${context}:`, getErrorMessage(error));
    }
  }

  async function closeTerminalQuietly(terminalId: string, context: string) {
    try {
      await remoteApi.closeTerminal(terminalId);
    } catch (error) {
      console.warn(`[helm] failed to close terminal during ${context}:`, getErrorMessage(error));
    }
  }

  async function openTerminalSafely(connectionId: string): Promise<{ value: TerminalInfo | null; error: unknown }> {
    return remoteApi
      .openTerminal(connectionId, 100, 30)
      .then((value) => ({ value, error: null }))
      .catch((error: unknown) => ({ value: null, error }));
  }

  function attachTerminal(sessionId: string, terminal: TerminalInfo) {
    registerTerminal(terminal.terminalId, sessionId);
  }

  function startTelemetry(connectionId: string, sessionId: string) {
    remoteApi
      .startTelemetry(connectionId, sessionId, 5000)
      .then((telemetryJob) => {
        if (!mountedRef.current || abortedConnectSessionsRef.current.has(sessionId)) return;
        updateSession(sessionId, (item) =>
          item.connectionId === connectionId
            ? {
                ...item,
                telemetryJobId: telemetryJob?.jobId ?? item.telemetryJobId,
              }
            : item,
        );
      })
      .catch((error) => {
        console.warn("[helm] failed to start telemetry:", getErrorMessage(error));
      });
  }

  function fetchSshVersion(connectionId: string, sessionId: string) {
    remoteApi
      .execOnConnection(connectionId, SSH_VERSION_COMMAND, 3000)
      .then((result) => {
        if (!mountedRef.current) return;
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
      .catch((error) => {
        console.warn("[helm] failed to fetch ssh version:", getErrorMessage(error));
      });
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
