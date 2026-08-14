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
import { isRuntimeSession, remoteSessionConfigId } from "../lib/session";
import {
  hasPendingUiConnectionForConfig,
  shouldApplySshStatusToSession,
} from "../lib/sshConnectionState";
import { applyTelemetryEvent } from "../lib/telemetryState";
import {
  formatSessionError,
  getHostKeyPayload,
  notifyEditorSessionDisconnected,
} from "./appHelpers";
import {
  addConnectingSessionId,
  activeSessionIdAfterClose,
  connectingSessionIdsFor,
  formatReconnectCountdownNotice,
  normalizeDisconnectReason,
  ReconnectCountdown,
  remainingOpenSessionIds,
  removeConnectingSessionIds,
} from "./sessionConnectionState";
import type { ConfigSnapshot, RemoteSession, TelemetrySnapshotEvent } from "../types";

type TerminalInfo = { terminalId: string };
type ConnectionAttempt = {
  id: string;
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
    connectionNotice: null,
    loginPath: null,
    terminal: [],
    telemetry: createEmptyTelemetry(session.host),
    filesPath: null,
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
  const hostKeyConfirmationsRef = useRef<Map<string, string>>(new Map());
  const connectingSessionIdsRef = useRef<ReadonlySet<string>>(connectingSessionIds);
  const uiInitiatedConnectCountsRef = useRef<Map<string, number>>(new Map());
  const uiManagedConnectionIdsRef = useRef<Set<string>>(new Set());
  const manualDisconnectSessionIdsRef = useRef<Set<string>>(new Set());
  const reconnectAttemptsRef = useRef<Map<string, number>>(new Map());
  const reconnectTimersRef = useRef<Map<string, ReconnectCountdown>>(new Map());
  const reconnectFailureReasonsRef = useRef<Map<string, string>>(new Map());
  const telemetryIntervalsRef = useRef<Map<string, number>>(new Map());
  const telemetryStartSeqRef = useRef<Map<string, number>>(new Map());
  const deferredTelemetryStartsRef = useRef<Map<string, string>>(new Map());
  const externalTerminalBackfillsRef = useRef<Map<string, string>>(new Map());
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
    for (const countdown of reconnectTimersRef.current.values()) countdown.cancel();
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
    hostKeyConfirmationsRef.current.clear();
    uiInitiatedConnectCountsRef.current.clear();
    uiManagedConnectionIdsRef.current.clear();
    manualDisconnectSessionIdsRef.current.clear();
    reconnectAttemptsRef.current.clear();
    reconnectFailureReasonsRef.current.clear();
    for (const countdown of reconnectTimersRef.current.values()) countdown.cancel();
    reconnectTimersRef.current.clear();
    telemetryIntervalsRef.current.clear();
    telemetryStartSeqRef.current.clear();
    deferredTelemetryStartsRef.current.clear();
    externalTerminalBackfillsRef.current.clear();
    const nextConnectingSessionIds = new Set<string>();
    connectingSessionIdsRef.current = nextConnectingSessionIds;
    setConnectingSessionIds(nextConnectingSessionIds);
  }

  function beginConnectionAttempt(sessionId: string) {
    const nextConnectingSessionIds = addConnectingSessionId(connectingSessionIdsRef.current, sessionId);
    if (!nextConnectingSessionIds) return null;
    const attempt: ConnectionAttempt = {
      id: crypto.randomUUID(),
      cancelled: false,
      connectionId: null,
    };
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
      hostKeyConfirmationsRef.current.delete(sessionId);
      cancelReconnect(sessionId);
      reconnectFailureReasonsRef.current.delete(sessionId);
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
      hostKeyConfirmationsRef.current.delete(targetId);
      cancelReconnect(targetId);
      reconnectFailureReasonsRef.current.delete(targetId);
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
        connectionNotice: null,
        loginPath: null,
        filesPath: null,
        files: [],
      });
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
    hostKeyConfirmationsRef.current.delete(id);
    cancelReconnect(id);
    reconnectFailureReasonsRef.current.delete(id);
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
      const nextIds = remainingOpenSessionIds(current, idSet);
      setActiveSessionId((currentActiveId) => (
        activeSessionIdAfterClose(currentActiveId, nextIds, idSet)
      ));
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
    hostKeyConfirmationsRef.current.delete(runtime.id);
    cancelReconnect(runtime.id);
    reconnectFailureReasonsRef.current.delete(runtime.id);
    setConnectionNotice(runtime.id, null);
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
    const connectionId = session.connectionId;
    manualDisconnectSessionIdsRef.current.add(session.id);
    hostKeyConfirmationsRef.current.delete(session.id);
    cancelReconnect(session.id);
    reconnectFailureReasonsRef.current.delete(session.id);
    try {
      await remoteApi.disconnect(connectionId);
      if (!mountedRef.current) return;
      let disconnectedCurrentConnection = false;
      updateSession(session.id, (item) => {
        if (item.connectionId !== connectionId) return item;
        disconnectedCurrentConnection = true;
        return {
          ...item,
          state: "disconnected",
          connectionId: null,
          connectedAt: null,
          sshVersion: null,
          terminalId: null,
          sftpId: null,
          telemetryJobId: null,
          connectionNotice: null,
          loginPath: null,
          telemetry: createEmptyTelemetry(item.host),
          filesPath: null,
          files: [],
        };
      });
      if (disconnectedCurrentConnection) notifyEditorSessionDisconnected(session.id);
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
      connectionNotice: null,
      loginPath: null,
      filesPath: null,
      files: [],
      terminal: [],
      telemetry: createEmptyTelemetry(item.host),
    }));
  }

  function handleSshStatus(payload: Awaited<ReturnType<typeof remoteApi.connect>>) {
    if (!mountedRef.current) return;
    const currentSessions = sessionsRef.current;
    const managedConnection = uiManagedConnectionIdsRef.current.has(payload.connectionId);
    const pendingUiConnection = hasPendingUiConnectionForConfig(
      currentSessions,
      payload.sessionId,
      connectingSessionIdsRef.current,
    );
    const disconnectReason = payload.status === "disconnected"
      ? normalizeDisconnectReason(payload.disconnectReason)
      : null;
    if (
      payload.status === "connected" &&
      !managedConnection &&
      !pendingUiConnection &&
      !currentSessions.some((session) => session.connectionId === payload.connectionId)
    ) {
      const baseSession = currentSessions.find((session) => session.id === payload.sessionId && !isRuntimeSession(session));
      if (baseSession) {
        const existingConnection = currentSessions.some((session) =>
          remoteSessionConfigId(session) === payload.sessionId && Boolean(session.connectionId),
        );
        if (existingConnection) {
          const runtime = createRuntimeSessionInstance(baseSession);
          runtime.connectionId = payload.connectionId;
          runtime.state = "connected";
          runtime.connectedAt = payload.connectedAt;
          runtime.host = payload.host;
          runtime.username = payload.username;
          setSessions((current) => [...current, runtime]);
          activateSession(runtime.id);
          void backfillExternalConnection(runtime.id, payload.connectionId);
          void fetchSshVersion(payload.connectionId, runtime.id);
          return;
        }
      } else {
        void disconnectQuietly(payload.connectionId, "orphan runtime connection cleanup");
        return;
      }
    }
    const reconnectTargets = payload.status === "disconnected"
      ? currentSessions.filter((session) => {
          const uiManaged = managedConnection || pendingUiConnection;
          return (
            shouldApplySshStatusToSession(session, payload, uiManaged) &&
            session.state === "connected" &&
            !manualDisconnectSessionIdsRef.current.has(session.id)
          );
        })
      : [];
    setSessions((current) =>
      current.map((session) => {
        const uiManaged = managedConnection || pendingUiConnection;
        if (!shouldApplySshStatusToSession(session, payload, uiManaged)) return session;
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
            connectionNotice: manualDisconnectSessionIdsRef.current.has(session.id)
              ? null
              : `连接中断：${disconnectReason}`,
            loginPath: null,
            filesPath: null,
            files: [],
            telemetry: createEmptyTelemetry(session.host),
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
          connectionNotice: payload.status === "connected" ? null : session.connectionNotice,
        };
      }),
    );
    for (const session of reconnectTargets) {
      reconnectFailureReasonsRef.current.set(session.id, disconnectReason!);
      appendTerminal(session.id, "error", `连接中断：${disconnectReason}`);
      scheduleReconnect(session.id);
    }
    if (payload.status === "disconnected") {
      uiManagedConnectionIdsRef.current.delete(payload.connectionId);
    }
  }

  async function backfillExternalConnection(
    sessionId: string,
    connectionId: string,
  ) {
    if (hasUiInitiatedConnect(sessionId)) return;
    if (externalTerminalBackfillsRef.current.get(sessionId) === connectionId) return;
    externalTerminalBackfillsRef.current.set(sessionId, connectionId);
    try {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      // Ubuntu 的 PAM MOTD 只会发送给连接建立后的首个会话通道。必须先打开
      // 交互 PTY，再执行登录目录探测；否则非交互 exec 会接收并吞掉原生 MOTD，
      // 随后的终端只能看到 Last login 和提示符。
      const terminal = await remoteApi.openTerminal(connectionId, 100, 30);
      if (!mountedRef.current) {
        await closeTerminalQuietly(terminal.terminalId, "unmounted external connection backfill");
        return;
      }
      const current = sessionsRef.current.find((item) => item.id === sessionId);
      if (current?.connectionId !== connectionId || current.state !== "connected") {
        await closeTerminalQuietly(terminal.terminalId, "stale external connection backfill");
        return;
      }
      registerTerminal(terminal.terminalId, sessionId);
      updateSession(sessionId, (item) => ({
        ...item,
        state: "connected",
        connectionId,
        connectionNotice: null,
        terminalId: terminal.terminalId,
      }));
      try {
        await remoteApi.startTerminal(terminal.terminalId);
      } catch (error) {
        await closeTerminalQuietly(terminal.terminalId, "failed external terminal start");
        updateSession(sessionId, (item) => (
          item.connectionId === connectionId && item.terminalId === terminal.terminalId
            ? { ...item, terminalId: null }
            : item
        ));
        throw error;
      }
      startConnectedServices(connectionId, sessionId);
      if (session) {
        const pathBeforeProbe = session.currentPath;
        void resolveConnectionPaths(
          connectionId,
          session.username,
          getSessionConfiguredPath(sessionId),
        ).then((paths) => {
          if (!mountedRef.current) return;
          const applyPaths = (item: RemoteSession): RemoteSession => {
            if (item.connectionId !== connectionId || item.state !== "connected") return item;
            return {
              ...item,
              currentPath: item.currentPath === pathBeforeProbe ? paths.initialPath : item.currentPath,
              loginPath: paths.loginPath,
            };
          };
          updateSession(sessionId, applyPaths);
        }).catch((error) => {
          console.warn("[helm] failed to apply external connection paths:", getErrorMessage(error));
        });
      }
    } catch (error) {
      const current = sessionsRef.current.find((item) => item.id === sessionId);
      if (mountedRef.current && current?.connectionId === connectionId && current.state === "connected") {
        appendTerminal(sessionId, "error", `终端不可用：${getErrorMessage(error)}`);
        startTelemetry(connectionId, sessionId);
        void fetchSshVersion(connectionId, sessionId);
      }
    } finally {
      if (externalTerminalBackfillsRef.current.get(sessionId) === connectionId) {
        externalTerminalBackfillsRef.current.delete(sessionId);
      }
    }
  }

  async function connectSession(
    session = activeSession,
    options: { activate?: boolean; reuseSession?: boolean; reconnectAttempt?: number } = {},
  ): Promise<boolean> {
    if (!mountedRef.current || !session) return false;
    const targetSession = options.reuseSession || isRuntimeSession(session)
      ? session
      : createRuntimeSessionInstance(session);
    const runtimeId = targetSession.id;
    const configId = remoteSessionConfigId(targetSession);
    const connectionProfile = sessionsRef.current.find((item) => item.id === configId) ?? targetSession;
    const attempt = beginConnectionAttempt(runtimeId);
    if (!attempt) return false;
    hostKeyConfirmationsRef.current.delete(runtimeId);
    manualDisconnectSessionIdsRef.current.delete(runtimeId);
    cancelReconnect(runtimeId);
    if (!options.reconnectAttempt) reconnectFailureReasonsRef.current.delete(runtimeId);
    if (!isRuntimeSession(session)) {
      setSessions((current) => current.some((item) => item.id === runtimeId) ? current : [...current, targetSession]);
    }
    if (options.activate !== false) activateSession(runtimeId);
    const markConnecting = (item: RemoteSession): RemoteSession => ({
      ...item,
      name: connectionProfile.name,
      groupId: connectionProfile.groupId,
      host: connectionProfile.host,
      username: connectionProfile.username,
      accent: connectionProfile.accent,
      favorite: connectionProfile.favorite,
      lastConnectedAt: connectionProfile.lastConnectedAt,
      state: "connecting",
      connectionId: null,
      connectedAt: null,
      sshVersion: null,
      terminalId: null,
      sftpId: null,
      telemetryJobId: null,
      connectionNotice: options.reconnectAttempt
        ? `正在进行第 ${options.reconnectAttempt} 次自动重连…`
        : "正在连接…",
      loginPath: null,
      filesPath: null,
      files: [],
    });
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

      const configuredPath = getSessionConfiguredPath(configId);
      const fallbackLoginPath = initialRemotePath(connectionProfile.username, null);
      const fallbackInitialPath = hasConfiguredInitialPath(configuredPath)
        ? initialRemotePath(connectionProfile.username, configuredPath)
        : fallbackLoginPath;
      // 连接后的首个会话通道必须是交互 PTY，确保 Ubuntu PAM 把原生 MOTD
      // 发给终端，而不是被登录目录探测用的非交互 exec 接收并丢弃。
      const terminalResult = await openTerminalSafely(connectionId);
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

      if (!mountedRef.current) {
        await closeTerminalQuietly(terminal.terminalId, "unmounted terminal cleanup");
        attempt.connectionId = null;
        await disconnectQuietly(connectionId, "unmounted connect session cleanup");
        return false;
      }
      const markConnected = (item: RemoteSession): RemoteSession => ({
        ...item,
        state: "connected",
        currentPath: fallbackInitialPath,
        loginPath: fallbackLoginPath,
        connectionId,
        connectedAt: connection?.connectedAt ?? new Date().toISOString(),
        terminalId: terminal.terminalId,
        sftpId: null,
        telemetryJobId: null,
        connectionNotice: null,
        filesPath: null,
        files: [],
      });
      updateSession(runtimeId, markConnected);
      try {
        await remoteApi.startTerminal(terminal.terminalId);
      } catch (error) {
        await closeTerminalQuietly(terminal.terminalId, "failed terminal start");
        throw error;
      }
      // 登录目录解析是一个额外 SSH exec 往返。终端启动并放行首屏输出后再探测，
      // 路径结果继续在后台补齐，不增加用户看到交互界面的等待时间。
      const pathsPromise = resolveConnectionPaths(
        connectionId,
        connectionProfile.username,
        configuredPath,
      );
      attempt.connectionId = null;
      startConnectedServices(connectionId, runtimeId);
      void pathsPromise.then((paths) => {
        if (!mountedRef.current) return;
        const applyPaths = (item: RemoteSession): RemoteSession => {
          if (item.connectionId !== connectionId || item.state !== "connected") return item;
          return {
            ...item,
            currentPath: item.currentPath === fallbackInitialPath ? paths.initialPath : item.currentPath,
            loginPath: paths.loginPath,
          };
        };
        updateSession(runtimeId, applyPaths);
      }).catch((error) => {
        console.warn("[helm] failed to apply connection paths:", getErrorMessage(error));
      });
      if (!options.reconnectAttempt) void recordSuccessfulConnection(configId);
      reconnectAttemptsRef.current.delete(runtimeId);
      reconnectFailureReasonsRef.current.delete(runtimeId);
      hostKeyConfirmationsRef.current.delete(runtimeId);
      return true;
    } catch (error) {
      if (attempt.connectionId) {
        const connectionId = attempt.connectionId;
        attempt.connectionId = null;
        await disconnectQuietly(connectionId, "connect session rollback");
      }
      if (attempt.cancelled) return false;
      if (!mountedRef.current) return false;
      const hostKey = getHostKeyPayload(error);
      const sessionError = normalizeDisconnectReason(formatSessionError(error, connectionProfile));
      reconnectFailureReasonsRef.current.set(runtimeId, sessionError);
      const connectionNotice = hostKey
        ? "等待确认主机密钥"
        : options.reconnectAttempt
          ? `第 ${options.reconnectAttempt} 次自动重连失败：${sessionError}`
          : `连接失败：${sessionError}`;
      const markFailed = (item: RemoteSession): RemoteSession => ({
        ...item,
        state: "failed",
        connectionNotice,
      });
      updateSession(runtimeId, markFailed);
      if (hostKey) {
        const confirmationId = crypto.randomUUID();
        hostKeyConfirmationsRef.current.set(runtimeId, confirmationId);
        const reconnectTarget = isRuntimeSession(targetSession)
          ? targetSession
          : sessionsRef.current.find((item) => item.id === runtimeId) ?? targetSession;
        Modal.confirm({
          title: hostKey.expectedFingerprint ? "主机密钥已变化" : "确认主机密钥",
          content: `${hostKey.host}:${hostKey.port} ${hostKey.algorithm} ${hostKey.fingerprint}`,
          okText: "信任并连接",
          cancelText: "取消",
          onOk: async () => {
            const currentBeforeTrust = sessionsRef.current.find((item) => item.id === runtimeId);
            if (
              !mountedRef.current
              || attempt.cancelled
              || hostKeyConfirmationsRef.current.get(runtimeId) !== confirmationId
              || currentBeforeTrust?.state !== "failed"
              || currentBeforeTrust.connectionNotice !== "等待确认主机密钥"
              || remoteSessionConfigId(currentBeforeTrust) !== configId
            ) return;
            const snapshot = await remoteApi.trustHostKey(
              hostKey.sessionId,
              hostKey.host,
              hostKey.port,
              hostKey.algorithm,
              hostKey.fingerprint,
            );
            const currentAfterTrust = sessionsRef.current.find((item) => item.id === runtimeId);
            if (
              !mountedRef.current
              || attempt.cancelled
              || hostKeyConfirmationsRef.current.get(runtimeId) !== confirmationId
              || currentAfterTrust?.state !== "failed"
              || currentAfterTrust.connectionNotice !== "等待确认主机密钥"
              || remoteSessionConfigId(currentAfterTrust) !== configId
            ) return;
            hostKeyConfirmationsRef.current.delete(runtimeId);
            applyConfigSnapshot(snapshot);
            await connectSession(reconnectTarget, { reuseSession: true });
          },
          onCancel: () => {
            if (hostKeyConfirmationsRef.current.get(runtimeId) !== confirmationId) return;
            hostKeyConfirmationsRef.current.delete(runtimeId);
            setConnectionNotice(runtimeId, "已取消主机密钥确认");
          },
        });
      } else if (!options.reconnectAttempt) {
        appendTerminal(runtimeId, "error", sessionError);
      }
      return false;
    } finally {
      finishConnectionAttempt(runtimeId, attempt);
    }
  }

  async function recordSuccessfulConnection(configId: string) {
    try {
      const snapshot = await vaultApi.sessionMarkRecent(configId);
      if (mountedRef.current) applySnapshot(snapshot);
    } catch (error) {
      console.warn("[helm] failed to record successful connection:", getErrorMessage(error));
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
    reconnectTimersRef.current.get(sessionId)?.cancel();
    reconnectTimersRef.current.delete(sessionId);
  }

  function setConnectionNotice(sessionId: string, connectionNotice: string | null) {
    const applyNotice = (session: RemoteSession): RemoteSession =>
      session.connectionNotice === connectionNotice ? session : { ...session, connectionNotice };
    if (mountedRef.current) updateSession(sessionId, applyNotice);
  }

  function scheduleReconnect(sessionId: string) {
    if (
      !AUTO_RECONNECT_ENABLED ||
      AUTO_RECONNECT_MAX_ATTEMPTS <= 0 ||
      manualDisconnectSessionIdsRef.current.has(sessionId) ||
      reconnectTimersRef.current.has(sessionId)
    ) return;
    const previousAttempts = reconnectAttemptsRef.current.get(sessionId) ?? 0;
    const failureReason = reconnectFailureReasonsRef.current.get(sessionId);
    if (previousAttempts >= AUTO_RECONNECT_MAX_ATTEMPTS) {
      setConnectionNotice(
        sessionId,
        `自动重连已停止：已尝试 ${previousAttempts} 次${failureReason ? `；最后失败原因：${failureReason}` : ""}，请手动重试`,
      );
      return;
    }
    const attempt = previousAttempts + 1;
    reconnectAttemptsRef.current.set(sessionId, attempt);
    const delay = AUTO_RECONNECT_DELAYS_MS[Math.min(attempt - 1, AUTO_RECONNECT_DELAYS_MS.length - 1)];
    const countdown = new ReconnectCountdown({
      delayMs: delay,
      scheduler: {
        now: () => Date.now(),
        setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clearTimeout: (handle) => window.clearTimeout(handle),
      },
      onTick: (remainingSeconds) => {
        if (reconnectTimersRef.current.get(sessionId) !== countdown) return;
        setConnectionNotice(sessionId, formatReconnectCountdownNotice({
          previousAttempts,
          nextAttempt: attempt,
          remainingSeconds,
          failureReason,
        }));
      },
      onElapsed: () => {
        if (reconnectTimersRef.current.get(sessionId) !== countdown) return;
        reconnectTimersRef.current.delete(sessionId);
        setConnectionNotice(sessionId, `正在进行第 ${attempt} 次自动重连…`);
        void runReconnectAttempt(sessionId, attempt);
      },
    });
    reconnectTimersRef.current.set(sessionId, countdown);
    countdown.start();
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
      reconnectFailureReasonsRef.current.delete(sessionId);
      setConnectionNotice(sessionId, null);
      return;
    }
    if (connectingSessionIdsRef.current.has(sessionId)) {
      reconnectAttemptsRef.current.set(sessionId, Math.max(0, attempt - 1));
      scheduleReconnect(sessionId);
      return;
    }
    const connected = await connectSession(session, {
      activate: false,
      reuseSession: true,
      reconnectAttempt: attempt,
    });
    if (
      !connected &&
      !manualDisconnectSessionIdsRef.current.has(sessionId) &&
      !connectingSessionIdsRef.current.has(sessionId) &&
      sessionsRef.current.find((item) => item.id === sessionId)?.connectionNotice !== "等待确认主机密钥"
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
          telemetryStartSeqRef.current.get(sessionId) !== requestSeq ||
          sessionsRef.current.find((item) => item.id === sessionId)?.connectionId !== connectionId
        ) {
          void remoteApi.stopTelemetry(telemetryJob.jobId).catch((error) => {
            console.debug("[helm] failed to stop stale telemetry job:", getErrorMessage(error));
          });
          return;
        }
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

  function handleTelemetryEvent(payload: TelemetrySnapshotEvent) {
    updateSession(payload.sessionId, (session) => {
      const result = applyTelemetryEvent(session, payload);
      if (!result.terminal) return result.session;
      telemetryIntervalsRef.current.delete(payload.sessionId);
      telemetryStartSeqRef.current.set(
        payload.sessionId,
        (telemetryStartSeqRef.current.get(payload.sessionId) ?? 0) + 1,
      );
      if (payload.error) {
        console.warn(`[helm] telemetry stopped for ${payload.sessionId}:`, payload.error);
      }
      return result.session;
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

  return {
    connectingSessionIds,
    resetSessionRuntime,
    activateSession,
    deleteSession,
    cancelConnectingSession,
    closeSession,
    disconnectSession,
    handleSshStatus,
    handleTelemetryEvent,
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
