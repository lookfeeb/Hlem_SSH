import { Modal } from "antd";
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { remoteApi } from "../api/remoteApi";
import { vaultApi } from "../api/vaultApi";
import { getErrorMessage, initialRemotePath } from "../lib/configMapping";
import {
  AUTO_RECONNECT_ENABLED,
  AUTO_RECONNECT_MAX_ATTEMPTS,
  INACTIVE_TELEMETRY_INTERVAL_MS,
  LOW_RESOURCE_MODE_ENABLED,
} from "../lib/performanceDefaults";
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
import {
  addConnectingSessionId,
  connectingSessionIdsFor,
  removeConnectingSessionIds,
} from "./sessionConnectionState";
import type { ConfigSnapshot, RemoteSession } from "../types";

type TerminalInfo = { terminalId: string };
type ConnectionAttempt = {
  cancelled: boolean;
  connectionId: string | null;
};

const SSH_VERSION_COMMAND =
  "sh -lc 'if command -v sshd >/dev/null 2>&1; then sshd -V 2>&1; elif [ -x /usr/sbin/sshd ]; then /usr/sbin/sshd -V 2>&1; elif [ -x /usr/local/sbin/sshd ]; then /usr/local/sbin/sshd -V 2>&1; else ssh -V 2>&1; fi'";
const LOGIN_PATH_COMMAND = "sh -lc 'pwd -P 2>/dev/null || pwd'";
const LOGIN_PATH_TIMEOUT_MS = 5000;
const ACTIVE_TELEMETRY_INTERVAL_MS = 5000;
const AUTO_RECONNECT_DELAYS_MS = [2000, 5000, 10_000, 20_000, 30_000] as const;

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
  sessionsRef: MutableRefObject<RemoteSession[]>;
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
  onSessionConnected: (sessionId: string, connectionId: string) => Promise<void> | void;
};

export function useSessionRuntime({
  sessions,
  sessionsRef,
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
  onSessionConnected,
}: UseSessionRuntimeOptions) {
  const [connectingSessionIds, setConnectingSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const mountedRef = useMountedRef();
  const connectionAttemptsRef = useRef<Map<string, ConnectionAttempt>>(new Map());
  const connectingSessionIdsRef = useRef<ReadonlySet<string>>(connectingSessionIds);
  const uiInitiatedConnectCountsRef = useRef<Map<string, number>>(new Map());
  const uiManagedConnectionIdsRef = useRef<Set<string>>(new Set());
  const manualDisconnectSessionIdsRef = useRef<Set<string>>(new Set());
  const reconnectAttemptsRef = useRef<Map<string, number>>(new Map());
  const reconnectTimersRef = useRef<Map<string, number>>(new Map());
  const telemetryIntervalsRef = useRef<Map<string, number>>(new Map());
  const telemetryStartSeqRef = useRef<Map<string, number>>(new Map());
  const deferredTelemetryStartsRef = useRef<Map<string, string>>(new Map());
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  useEffect(() => {
    const connectedIds = new Set<string>();
    for (const session of sessions) {
      if (session.state !== "connected" || !session.connectionId) continue;
      connectedIds.add(session.id);
      if (deferredTelemetryStartsRef.current.has(session.id)) continue;
      const interval = desiredTelemetryInterval(session.id);
      if (telemetryIntervalsRef.current.get(session.id) !== interval) {
        startTelemetry(session.connectionId, session.id, interval);
      }
    }
    for (const sessionId of telemetryIntervalsRef.current.keys()) {
      if (!connectedIds.has(sessionId)) telemetryIntervalsRef.current.delete(sessionId);
    }
  }, [sessions, activeSessionId]);

  useEffect(() => () => {
    for (const timer of reconnectTimersRef.current.values()) window.clearTimeout(timer);
    reconnectTimersRef.current.clear();
  }, []);

  function resetSessionRuntime() {
    for (const attempt of connectionAttemptsRef.current.values()) {
      attempt.cancelled = true;
      if (attempt.connectionId) {
        const connectionId = attempt.connectionId;
        attempt.connectionId = null;
        void disconnectQuietly(connectionId, "reset session runtime");
      }
    }
    connectionAttemptsRef.current.clear();
    manualDisconnectSessionIdsRef.current.clear();
    reconnectAttemptsRef.current.clear();
    for (const timer of reconnectTimersRef.current.values()) window.clearTimeout(timer);
    reconnectTimersRef.current.clear();
    telemetryIntervalsRef.current.clear();
    telemetryStartSeqRef.current.clear();
    deferredTelemetryStartsRef.current.clear();
    const nextConnectingSessionIds = new Set<string>();
    connectingSessionIdsRef.current = nextConnectingSessionIds;
    setConnectingSessionIds(nextConnectingSessionIds);
  }

  function beginConnectionAttempt(sessionId: string) {
    const nextConnectingSessionIds = addConnectingSessionId(connectingSessionIdsRef.current, sessionId);
    if (!nextConnectingSessionIds) return null;
    const attempt: ConnectionAttempt = { cancelled: false, connectionId: null };
    connectionAttemptsRef.current.set(sessionId, attempt);
    connectingSessionIdsRef.current = nextConnectingSessionIds;
    setConnectingSessionIds(nextConnectingSessionIds);
    uiInitiatedConnectCountsRef.current.set(
      sessionId,
      (uiInitiatedConnectCountsRef.current.get(sessionId) ?? 0) + 1,
    );
    return attempt;
  }

  function finishConnectionAttempt(sessionId: string, attempt: ConnectionAttempt) {
    const remainingUiAttempts = (uiInitiatedConnectCountsRef.current.get(sessionId) ?? 1) - 1;
    if (remainingUiAttempts > 0) {
      uiInitiatedConnectCountsRef.current.set(sessionId, remainingUiAttempts);
    } else {
      uiInitiatedConnectCountsRef.current.delete(sessionId);
    }
    if (connectionAttemptsRef.current.get(sessionId) !== attempt) return;
    connectionAttemptsRef.current.delete(sessionId);
    const nextConnectingSessionIds = removeConnectingSessionIds(connectingSessionIdsRef.current, [sessionId]);
    connectingSessionIdsRef.current = nextConnectingSessionIds;
    if (mountedRef.current) setConnectingSessionIds(nextConnectingSessionIds);
  }

  function hasUiInitiatedConnect(sessionId: string) {
    return (uiInitiatedConnectCountsRef.current.get(sessionId) ?? 0) > 0;
  }

  function updateSessionRef(sessionId: string, updater: (session: RemoteSession) => RemoteSession) {
    sessionsRef.current = sessionsRef.current.map((session) =>
      session.id === sessionId ? updater(session) : session,
    );
  }

  function activateSession(id: string) {
    setOpenSessionIds((current) => (current.includes(id) ? current : [...current, id]));
    setActiveSessionId(id);
  }

  function runtimeSessionsForConfig(configId: string) {
    return sessionsRef.current.filter((session) => remoteSessionConfigId(session) === configId && isRuntimeSession(session));
  }

  async function deleteSession(id: string) {
    const configId = id;
    const baseSession = sessionsRef.current.find((session) => session.id === configId);
    const runtimeSessions = runtimeSessionsForConfig(configId);
    for (const sessionId of [configId, ...runtimeSessions.map((session) => session.id)]) {
      manualDisconnectSessionIdsRef.current.add(sessionId);
      cancelReconnect(sessionId);
    }
    await cancelConnectingSession(configId);
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
    const targetIds = connectingSessionIdsFor(
      id,
      sessionsRef.current,
      connectingSessionIdsRef.current,
    );
    if (targetIds.length === 0) return;

    const disconnects: Promise<void>[] = [];
    for (const targetId of targetIds) {
      manualDisconnectSessionIdsRef.current.add(targetId);
      cancelReconnect(targetId);
      const attempt = connectionAttemptsRef.current.get(targetId);
      if (!attempt) continue;
      attempt.cancelled = true;
      if (connectionAttemptsRef.current.get(targetId) === attempt) {
        connectionAttemptsRef.current.delete(targetId);
      }
      if (attempt.connectionId) {
        const connectionId = attempt.connectionId;
        attempt.connectionId = null;
        disconnects.push(disconnectQuietly(connectionId, "cancel connecting session"));
      }
      const resetConnection = (item: RemoteSession): RemoteSession => ({
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
      });
      updateSessionRef(targetId, resetConnection);
      if (mountedRef.current) updateSession(targetId, resetConnection);
    }
    const nextConnectingSessionIds = removeConnectingSessionIds(
      connectingSessionIdsRef.current,
      targetIds,
    );
    connectingSessionIdsRef.current = nextConnectingSessionIds;
    if (mountedRef.current) setConnectingSessionIds(nextConnectingSessionIds);
    await Promise.all(disconnects);
  }

  async function closeSession(id: string) {
    const session = sessions.find((item) => item.id === id);
    manualDisconnectSessionIdsRef.current.add(id);
    cancelReconnect(id);
    if (connectingSessionIdsFor(id, sessionsRef.current, connectingSessionIdsRef.current).length > 0) {
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
    if (!runtime) return;
    manualDisconnectSessionIdsRef.current.add(runtime.id);
    cancelReconnect(runtime.id);
    if (!runtime.connectionId) return;
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
    manualDisconnectSessionIdsRef.current.add(session.id);
    cancelReconnect(session.id);
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
    const currentSessions = sessionsRef.current;
    const managedConnection = uiManagedConnectionIdsRef.current.has(payload.connectionId);
    const reconnectTargets = payload.status === "disconnected"
      ? currentSessions.filter((session) => {
          const matchesConnection = Boolean(session.connectionId && session.connectionId === payload.connectionId);
          const matchesConfig = session.id === payload.sessionId && !isRuntimeSession(session);
          const uiManaged = managedConnection || currentSessions.some((item) =>
              remoteSessionConfigId(item) === payload.sessionId && hasUiInitiatedConnect(item.id),
            );
          return (matchesConnection || (matchesConfig && !uiManaged)) && session.state === "connected";
        })
      : [];
    setSessions((current) =>
      current.map((session) => {
        const matchesConnection = Boolean(session.connectionId && session.connectionId === payload.connectionId);
        const matchesConfig = session.id === payload.sessionId && !isRuntimeSession(session);
        const uiManaged = managedConnection || current.some((item) =>
            remoteSessionConfigId(item) === payload.sessionId && hasUiInitiatedConnect(item.id),
          );
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
          !uiManaged &&
          !session.terminalId
        ) {
          void backfillExternalConnection(session.id, payload.connectionId);
        }
        if (payload.status === "connected" && !uiManaged && !session.sshVersion) {
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
    for (const session of reconnectTargets) scheduleReconnect(session.id);
    if (payload.status === "disconnected") {
      uiManagedConnectionIdsRef.current.delete(payload.connectionId);
    }
  }

  async function backfillExternalConnection(
    sessionId: string,
    connectionId: string,
  ) {
    if (hasUiInitiatedConnect(sessionId)) return;
    try {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      void prewarmSftp(connectionId);
      const [paths, terminal] = await Promise.all([
        session
          ? resolveConnectionPaths(connectionId, session.username, getSessionConfiguredPath(sessionId))
          : Promise.resolve(null),
        remoteApi.openTerminal(connectionId, 100, 30),
      ]);
      if (!mountedRef.current) {
        await closeTerminalQuietly(terminal.terminalId, "unmounted external connection backfill");
        return;
      }
      registerTerminal(terminal.terminalId, sessionId);
      updateSessionRef(sessionId, (item) => ({
        ...item,
        state: "connected",
        connectionId,
        ...(paths ? { currentPath: paths.initialPath, loginPath: paths.loginPath } : {}),
        terminalId: terminal.terminalId,
      }));
      updateSession(sessionId, (item) => ({
        ...item,
        state: "connected",
        connectionId,
        ...(paths ? { currentPath: paths.initialPath, loginPath: paths.loginPath } : {}),
        terminalId: terminal.terminalId,
      }));
      startConnectedServices(connectionId, sessionId);
    } catch (error) {
      if (mountedRef.current) {
        appendTerminal(sessionId, "error", `终端不可用：${getErrorMessage(error)}`);
        startTelemetry(connectionId, sessionId);
        void fetchSshVersion(connectionId, sessionId);
      }
    }
  }

  async function connectSession(
    session = activeSession,
    options: { activate?: boolean; reuseSession?: boolean } = {},
  ): Promise<boolean> {
    if (!mountedRef.current || !session) return false;
    const targetSession = options.reuseSession || isRuntimeSession(session)
      ? session
      : createRuntimeSessionInstance(session);
    const runtimeId = targetSession.id;
    const configId = remoteSessionConfigId(targetSession);
    const attempt = beginConnectionAttempt(runtimeId);
    if (!attempt) return false;
    manualDisconnectSessionIdsRef.current.delete(runtimeId);
    cancelReconnect(runtimeId);
    if (!isRuntimeSession(session)) {
      if (!sessionsRef.current.some((item) => item.id === runtimeId)) {
        sessionsRef.current = [...sessionsRef.current, targetSession];
      }
      setSessions((current) => current.some((item) => item.id === runtimeId) ? current : [...current, targetSession]);
    }
    if (options.activate !== false) activateSession(runtimeId);
    const markConnecting = (item: RemoteSession): RemoteSession => ({
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
    });
    updateSessionRef(runtimeId, markConnecting);
    updateSession(runtimeId, markConnecting);
    let connection: Awaited<ReturnType<typeof remoteApi.connect>> | null = null;
    try {
      connection = await remoteApi.connect(configId);
      const connectionId = connection.connectionId;
      uiManagedConnectionIdsRef.current.add(connectionId);
      attempt.connectionId = connectionId;
      if (!mountedRef.current) {
        attempt.connectionId = null;
        await disconnectQuietly(connectionId, "unmounted connect session cleanup");
        return false;
      }
      if (await disconnectIfCancelled(attempt, connectionId)) return false;

      void prewarmSftp(connectionId);
      const [paths, terminalResult] = await Promise.all([
        resolveConnectionPaths(connectionId, targetSession.username, getSessionConfiguredPath(configId)),
        openTerminalSafely(connectionId),
      ]);
      if (!mountedRef.current) {
        attempt.connectionId = null;
        await disconnectQuietly(connectionId, "unmounted connect session cleanup");
        return false;
      }
      if (await disconnectIfCancelled(attempt, connectionId)) return false;

      const terminal = terminalResult.value;
      if (!terminal) {
        const detail = terminalResult.error ? `：${getErrorMessage(terminalResult.error)}` : "";
        throw new Error(`SSH 已连接，但远端拒绝打开终端通道${detail}`);
      }
      attachTerminal(runtimeId, terminal);

      if (!mountedRef.current) return false;
      const markConnected = (item: RemoteSession): RemoteSession => ({
        ...item,
        state: "connected",
        currentPath: paths.initialPath,
        loginPath: paths.loginPath,
        connectionId,
        connectedAt: connection?.connectedAt ?? new Date().toISOString(),
        terminalId: terminal.terminalId,
        sftpId: null,
        telemetryJobId: null,
        files: [],
      });
      updateSessionRef(runtimeId, markConnected);
      updateSession(runtimeId, markConnected);
      attempt.connectionId = null;
      startConnectedServices(connectionId, runtimeId);
      reconnectAttemptsRef.current.delete(runtimeId);
      return true;
    } catch (error) {
      if (attempt.connectionId) {
        const connectionId = attempt.connectionId;
        attempt.connectionId = null;
        await disconnectQuietly(connectionId, "connect session rollback");
      }
      if (attempt.cancelled) return false;
      if (!mountedRef.current) return false;
      const markFailed = (item: RemoteSession): RemoteSession => ({ ...item, state: "failed" });
      updateSessionRef(runtimeId, markFailed);
      updateSession(runtimeId, markFailed);
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
      return false;
    } finally {
      finishConnectionAttempt(runtimeId, attempt);
    }
  }

  async function disconnectIfCancelled(attempt: ConnectionAttempt, connectionId: string) {
    if (!attempt.cancelled) return false;
    if (attempt.connectionId === connectionId) {
      attempt.connectionId = null;
      await disconnectQuietly(connectionId, "cancelled connection cleanup");
    }
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

  async function prewarmSftp(connectionId: string) {
    try {
      await remoteApi.openSftp(connectionId);
    } catch (error) {
      console.warn("[helm] failed to prewarm sftp:", getErrorMessage(error));
    }
  }

  function startConnectedServices(connectionId: string, sessionId: string) {
    deferredTelemetryStartsRef.current.set(sessionId, connectionId);
    void (async () => {
      try {
        await onSessionConnected(sessionId, connectionId);
      } catch (error) {
        console.warn("[helm] failed to initialize connected session services:", getErrorMessage(error));
      } finally {
        if (deferredTelemetryStartsRef.current.get(sessionId) !== connectionId) return;
        deferredTelemetryStartsRef.current.delete(sessionId);
        if (!mountedRef.current) return;
        const current = sessionsRef.current.find((session) => session.id === sessionId);
        if (current?.state !== "connected" || current.connectionId !== connectionId) return;
        startTelemetry(connectionId, sessionId);
        void fetchSshVersion(connectionId, sessionId);
      }
    })();
  }

  function desiredTelemetryInterval(sessionId: string) {
    if (!LOW_RESOURCE_MODE_ENABLED || sessionId === activeSessionIdRef.current) {
      return ACTIVE_TELEMETRY_INTERVAL_MS;
    }
    return INACTIVE_TELEMETRY_INTERVAL_MS;
  }

  function cancelReconnect(sessionId: string) {
    const timer = reconnectTimersRef.current.get(sessionId);
    if (timer !== undefined) window.clearTimeout(timer);
    reconnectTimersRef.current.delete(sessionId);
  }

  function scheduleReconnect(sessionId: string) {
    if (
      !AUTO_RECONNECT_ENABLED ||
      AUTO_RECONNECT_MAX_ATTEMPTS <= 0 ||
      manualDisconnectSessionIdsRef.current.has(sessionId) ||
      reconnectTimersRef.current.has(sessionId)
    ) return;
    const previousAttempts = reconnectAttemptsRef.current.get(sessionId) ?? 0;
    if (previousAttempts >= AUTO_RECONNECT_MAX_ATTEMPTS) {
      appendTerminal(sessionId, "error", `自动重连已停止：已尝试 ${previousAttempts} 次`);
      return;
    }
    const attempt = previousAttempts + 1;
    reconnectAttemptsRef.current.set(sessionId, attempt);
    const delay = AUTO_RECONNECT_DELAYS_MS[Math.min(attempt - 1, AUTO_RECONNECT_DELAYS_MS.length - 1)];
    appendTerminal(sessionId, "system", `连接意外断开，${Math.round(delay / 1000)} 秒后进行第 ${attempt} 次自动重连`);
    const timer = window.setTimeout(() => {
      reconnectTimersRef.current.delete(sessionId);
      void runReconnectAttempt(sessionId, attempt);
    }, delay);
    reconnectTimersRef.current.set(sessionId, timer);
  }

  async function runReconnectAttempt(sessionId: string, attempt: number) {
    if (
      !mountedRef.current ||
      !AUTO_RECONNECT_ENABLED ||
      manualDisconnectSessionIdsRef.current.has(sessionId)
    ) return;
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    if (!session) return;
    if (session.state === "connected") {
      reconnectAttemptsRef.current.delete(sessionId);
      return;
    }
    if (connectingSessionIdsRef.current.has(sessionId)) {
      reconnectAttemptsRef.current.set(sessionId, Math.max(0, attempt - 1));
      scheduleReconnect(sessionId);
      return;
    }
    const connected = await connectSession(session, { activate: false, reuseSession: true });
    if (
      !connected &&
      !manualDisconnectSessionIdsRef.current.has(sessionId) &&
      !connectingSessionIdsRef.current.has(sessionId)
    ) {
      scheduleReconnect(sessionId);
    }
  }

  function startTelemetry(
    connectionId: string,
    sessionId: string,
    intervalMs = desiredTelemetryInterval(sessionId),
  ) {
    telemetryIntervalsRef.current.set(sessionId, intervalMs);
    const requestSeq = (telemetryStartSeqRef.current.get(sessionId) ?? 0) + 1;
    telemetryStartSeqRef.current.set(sessionId, requestSeq);
    remoteApi
      .startTelemetry(connectionId, sessionId, intervalMs)
      .then((telemetryJob) => {
        if (
          !mountedRef.current ||
          telemetryStartSeqRef.current.get(sessionId) !== requestSeq
        ) return;
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
    connectingSessionIds,
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
