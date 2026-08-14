import { Modal } from "antd";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { appApi } from "./api/appApi";
import { appEvents } from "./api/appEvents";
import { remoteApi } from "./api/remoteApi";
import { defaultBackupSettings, vaultApi } from "./api/vaultApi";
import {
  BackupModal,
  SettingsModal,
  TransferCenter,
  TunnelDrawer,
} from "./app/lazyComponents";
import {
  formatSessionError,
  remoteSessionPath,
} from "./app/appHelpers";
import { useApiServerRuntime } from "./app/useApiServerRuntime";
import { useAppBootstrap } from "./app/useAppBootstrap";
import { useAppUpdater } from "./app/useAppUpdater";
import { useBackupWorkflow } from "./app/useBackupWorkflow";
import { useFileSaveRecords } from "./app/useFileSaveRecords";
import { useSettingsPersistence } from "./app/useSettingsPersistence";
import { useSessionConfigWorkflow } from "./app/useSessionConfigWorkflow";
import { useSessionRuntime } from "./app/useSessionRuntime";
import { useSftpFiles } from "./app/useSftpFiles";
import { planSftpInitialization } from "./app/sftpSessionState";
import { useTerminalRuntime } from "./app/useTerminalRuntime";
import { useTrayActions } from "./app/useTrayActions";
import { useTransferActions } from "./app/useTransferActions";
import { useTransferHistory } from "./app/useTransferHistory";
import { useTunnelRuntime } from "./app/useTunnelRuntime";
import { AppLoadingFallback } from "./components/shared/AppLoadingFallback";
import { AppProviders } from "./components/shared/AppProviders";
import { AppStatusBar } from "./components/AppStatusBar";
import { ConnectionSidebar } from "./components/ConnectionSidebar";
import { MigrationGate } from "./components/MigrationGate";
import { SessionConfigModal } from "./components/SessionConfigModal";
import { closeSharedDetachedEditorChannel } from "./components/FileManager";
import { SessionWorkspace, type SessionWorkspaceActions } from "./components/SessionWorkspace";
import { TopBar } from "./components/TopBar";
import { EmptyWorkspace } from "./components/shared/EmptyWorkspace";
import { configToRemoteSession, getErrorMessage } from "./lib/configMapping";
import { isConfigSnapshotCurrent } from "./lib/configSnapshot";
import { getParentPath as getRemoteParentPath, normalizePath as normalizeRemotePath } from "./lib/path";
import { createKeyedInFlightCache } from "./lib/keyedInFlight";
import { isRuntimeSession, remoteSessionConfigId } from "./lib/session";
import { commitRefState } from "./lib/stateRef";
import { invalidateAsyncQueues } from "./lib/asyncQueue";
import { loadStableSnapshot } from "./lib/stableSnapshot";
import { emitSftpDirectoryInvalidation } from "./lib/sftpDirectoryEvents";
import { TERMINAL_SCROLLBACK, TERMINAL_WEBGL_ENABLED } from "./lib/performanceDefaults";
import type {
  ConfigSnapshot,
  QuickCommand,
  RemoteFileEntry,
  RemoteSession,
  SftpChangedEvent,
} from "./types";

const SFTP_REFRESH_DEBOUNCE_MS = 120;
const EMPTY_QUICK_COMMANDS: QuickCommand[] = [];

function App() {
  const [configSnapshot, setConfigSnapshot] = useState<ConfigSnapshot>();
  const [sessions, setSessionsState] = useState<RemoteSession[]>([]);
  const [openSessionIds, setOpenSessionIds] = useState<string[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [transferCenterOpen, setTransferCenterOpen] = useState(false);
  const {
    transfers,
    transfersRef,
    setPersistedTransfers,
    resetTransferHistory,
    refreshTransferHistory,
    applyTransferHistorySnapshot,
    clearFinishedTransferHistory,
  } = useTransferHistory();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tunnelOpen, setTunnelOpen] = useState(false);
  const [aiApiOpen, setAiApiOpen] = useState(false);
  const [earlyEventsReady, setEarlyEventsReady] = useState(false);
  const [fileLoadingSessionIds, setFileLoadingSessionIds] = useState<Set<string>>(new Set());
  const sessionsRef = useRef<RemoteSession[]>([]);
  const configSnapshotRef = useRef<ConfigSnapshot | undefined>(configSnapshot);
  const autoSftpConnectionKeysRef = useRef<Set<string>>(new Set());
  const fileLoadingCountsRef = useRef<Map<string, number>>(new Map());
  const sftpListRequestsRef = useRef(createKeyedInFlightCache<string, RemoteFileEntry[]>());
  const sftpRefreshTimersRef = useRef<Map<string, number>>(new Map());
  const sftpChangedDirectoriesRef = useRef<Map<string, Set<string>>>(new Map());
  const connectionSectionSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const connectionSectionSaveVersionRef = useRef(0);
  const sshEventVersionRef = useRef(0);
  const connectionListEpochRef = useRef(0);
  const sessionWorkspaceActionsRef = useRef<SessionWorkspaceActions | null>(null);
  const setSessions: Dispatch<SetStateAction<RemoteSession[]>> = useCallback(
    (action) => commitRefState(sessionsRef, setSessionsState, action),
    [],
  );
  useEffect(() => () => {
    clearPendingSftpRefreshes();
    sftpListRequestsRef.current.clear();
    closeSharedDetachedEditorChannel();
  }, []);
  const sftpListRequestKey = useCallback(
    (sftpId: string, path: string) => `${sftpId}:${normalizeRemotePath(path)}`,
    [],
  );
  const invalidateSftpListRequest = useCallback((sftpId: string, path: string) => {
    sftpListRequestsRef.current.invalidate(sftpListRequestKey(sftpId, path));
  }, [sftpListRequestKey]);
  const listSftpFiles = useCallback((sftpId: string, path: string, force = false) => {
    const normalizedPath = normalizeRemotePath(path);
    const requestKey = sftpListRequestKey(sftpId, normalizedPath);
    if (force) sftpListRequestsRef.current.invalidate(requestKey);
    return sftpListRequestsRef.current.run(
      requestKey,
      () => remoteApi.listFiles(sftpId, normalizedPath),
    );
  }, [sftpListRequestKey]);
  const {
    apiServerRunning,
    setApiServerRunning,
    initializeApiServerRuntime,
  } = useApiServerRuntime();

  const earlyEventHandlersRef = useRef({ applySnapshot, setApiServerRunning });
  earlyEventHandlersRef.current = { applySnapshot, setApiServerRunning };

  useEffect(() => {
    let disposed = false;
    let cleanups: Array<() => void> = [];
    void Promise.allSettled([
      appEvents.onConfigChanged((payload) => earlyEventHandlersRef.current.applySnapshot(payload)),
      appEvents.onApiStatus((payload) => earlyEventHandlersRef.current.setApiServerRunning(payload.running)),
    ]).then((results) => {
      const items = results.flatMap((result) => {
        if (result.status === "fulfilled") return [result.value];
        console.warn("[helm] failed to register early app event listener:", getErrorMessage(result.reason));
        return [];
      });
      if (disposed) {
        items.forEach((cleanup) => cleanup());
        return;
      }
      cleanups = items;
      setEarlyEventsReady(true);
      // 状态查询必须发生在监听器注册后，避免自动启动事件落在初始化窗口里。
      void initializeApiServerRuntime();
    });
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);
  const {
    appReady,
    migrationNeeded,
    migrationBusy,
    migrationError,
    bootstrapError,
    appInfo,
    setAppInfo,
    handleMigrate,
    handleSkipMigration,
  } = useAppBootstrap({
    enabled: earlyEventsReady,
    applySnapshot,
    onFrontendReady: initializeApiServerRuntime,
  });
  const {
    forwards,
    resetForwards,
    createTunnel,
    updateTunnel,
    deleteTunnel,
    startTunnel,
    stopTunnel,
  } = useTunnelRuntime({
    appReady,
    applyConfigSnapshot,
  });
  const {
    registerTerminal,
    appendTerminal,
    resetTerminalRuntime,
    handleTerminalOutput,
    handleTerminalClosed,
    sendTerminalData,
    sendTerminalCommand,
    resizeTerminal,
    clearTerminal,
  } = useTerminalRuntime({
    sessionsRef,
    setSessions,
    updateSession,
    setSessionFilesLoading,
    formatSessionError,
    listFiles: listSftpFiles,
  });
  const {
    upsertTransfer,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    retryTransfer,
    removeTransfer,
  } = useTransferActions({
    sessionsRef,
    transfersRef,
    setPersistedTransfers,
    applyTransferHistorySnapshot,
    activeSessionId,
    appendTerminal: (sessionId, kind, content) => appendTerminal(sessionId, kind, content),
  });
  const {
    saveSettings,
    upsertQuickCommand,
    deleteQuickCommand,
    invalidateSettingsMutations,
  } = useSettingsPersistence({
    applyConfigSnapshot,
  });
  const configSessions = useMemo(() => sessions.filter((session) => !isRuntimeSession(session)), [sessions]);
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const openSessions = useMemo(
    () => openSessionIds.flatMap((id) => {
      const session = sessionsById.get(id);
      return session ? [session] : [];
    }),
    [openSessionIds, sessionsById],
  );
  const activeSession = useMemo(
    () => openSessions.find((session) => session.id === activeSessionId) ?? openSessions[0],
    [activeSessionId, openSessions],
  );
  const activeConfigId = activeSession ? remoteSessionConfigId(activeSession) : "";
  const sidebarSessions = useMemo(
    () => configSessions.map((session) => sessionForSidebar(session, sessions, activeSessionId)),
    [activeSessionId, configSessions, sessions],
  );
  const {
    sessionModal,
    addSession,
    editSession,
    saveSessionConfig,
    closeSessionConfigModal,
  } = useSessionConfigWorkflow({
    configSnapshot,
    activeSessionId: activeConfigId,
    applySnapshot,
  });
  const {
    changePath,
    refreshSessionFiles,
    runFileOperation,
    uploadLocalFiles,
    downloadRemoteFiles,
    readRemoteText,
    writeRemoteTextRaw,
    refreshFiles,
    refreshFilesForTransfer,
    searchRemoteFile,
    listRemoteDirectory,
    ensureSessionSftp,
  } = useSftpFiles({
    activeSession,
    sessionsRef,
    updateSession,
    setSessionFilesLoading,
    listFiles: listSftpFiles,
    appendTerminal: (sessionId, kind, content) => appendTerminal(sessionId, kind, content),
    formatSessionError,
    upsertTransfer,
    openTransferCenter: () => setTransferCenterOpen(true),
  });
  const {
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
  } = useSessionRuntime({
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
    appendTerminal: (sessionId, kind, content) => appendTerminal(sessionId, kind, content),
    getSessionConfiguredPath: (sessionId) => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const configId = session ? remoteSessionConfigId(session) : sessionId;
      const config = configSnapshotRef.current?.data.sessions.find((item) => item.id === configId);
      return config ? config.defaultPath || config.sftp.defaultPath : null;
    },
    onSessionConnected: ensureSessionSftp,
  });
  const {
    fileSaveRecords,
    writeRemoteText,
    retryFileSaveRecord,
    removeFileSaveRecord,
    clearFileSaveRecords,
  } = useFileSaveRecords({
    writeRemoteTextRaw,
    onSaveFailed: () => setTransferCenterOpen(true),
  });
  const {
    updateInfo,
    updateError,
    updateChecking,
    updateDownloading,
    downloadedUpdatePath,
    checkForUpdate,
    downloadUpdate,
    installUpdate,
    ignoreUpdateVersion,
  } = useAppUpdater({
    appReady,
    appInfo,
    setAppInfo,
    configSnapshotRef,
    applyConfigSnapshot,
  });
  const {
    backupOpen,
    setBackupOpen,
    backupBusy,
    exportBackup,
    importBackup,
    restoreBackupRecord,
    saveBackupSettings,
    runConfiguredBackup,
    deleteBackupRecord,
    clearBackupRecords,
  } = useBackupWorkflow({
    applySnapshot,
    applyConfigSnapshot,
    resetRuntimeState: resetRuntimeStateForSnapshot,
    prepareConfigReplacement,
  });
  useTrayActions({
    appReady,
    onOpenSettings: () => setSettingsOpen(true),
    onOpenBackup: () => setBackupOpen(true),
    onRunBackup: () => void runConfiguredBackup(),
  });

  useEffect(() => {
    if (!appReady) return;
    const plan = planSftpInitialization(sessions, autoSftpConnectionKeysRef.current);
    for (const target of plan.targets) {
      autoSftpConnectionKeysRef.current.add(target.connectionKey);
      void ensureSessionSftp(target.sessionId, target.connectionId).catch((error) => {
        console.warn("[helm] failed to initialize session sftp:", getErrorMessage(error));
      });
    }
    for (const connectionKey of autoSftpConnectionKeysRef.current) {
      if (!plan.liveConnectionKeys.has(connectionKey)) autoSftpConnectionKeysRef.current.delete(connectionKey);
    }
  }, [appReady, sessions]);

  const appEventHandlersRef = useRef({
    handleSshStatus,
    handleSftpChanged,
    handleTerminalOutput,
    handleTerminalClosed,
    handleTelemetryEvent,
    upsertTransfer,
    refreshFilesForTransfer,
    applyConfigSnapshot,
    appendTerminal,
  });
  appEventHandlersRef.current = {
    handleSshStatus,
    handleSftpChanged,
    handleTerminalOutput,
    handleTerminalClosed,
    handleTelemetryEvent,
    upsertTransfer,
    refreshFilesForTransfer,
    applyConfigSnapshot,
    appendTerminal,
  };

  useEffect(() => {
    if (!appReady) return;
    let disposed = false;
    let cleanups: Array<() => void> = [];
    void Promise.allSettled([
      remoteApi.onSshStatus((payload) => {
        sshEventVersionRef.current += 1;
        appEventHandlersRef.current.handleSshStatus(payload);
      }),
      remoteApi.onSftpChanged((payload) => appEventHandlersRef.current.handleSftpChanged(payload)),
      remoteApi.onTerminalOutput((payload) => appEventHandlersRef.current.handleTerminalOutput(payload)),
      remoteApi.onTerminalClosed((payload) => appEventHandlersRef.current.handleTerminalClosed(payload)),
      remoteApi.onTelemetrySnapshot((payload) => appEventHandlersRef.current.handleTelemetryEvent(payload)),
      remoteApi.onTransferProgress((payload) => appEventHandlersRef.current.upsertTransfer(payload)),
      remoteApi.onTransferCompleted((payload) => {
        appEventHandlersRef.current.upsertTransfer(payload);
        if (payload.direction === "upload") {
          invalidateSftpDirectories(payload.sftpId, [getRemoteParentPath(payload.remotePath)]);
        }
        void appEventHandlersRef.current.refreshFilesForTransfer(payload).catch((error) => {
          console.warn("[helm] failed to refresh files after transfer:", getErrorMessage(error));
        });
      }),
      remoteApi.onTransferFailed((payload) => appEventHandlersRef.current.upsertTransfer(payload)),
      remoteApi.onHostKeyVerify((payload) => {
        appEventHandlersRef.current.appendTerminal(
          payload.sessionId,
          "system",
          `主机密钥待确认：${payload.fingerprint}`,
        );
      }),
    ]).then((results) => {
      const items = results.flatMap((result) => {
        if (result.status === "fulfilled") return [result.value];
        console.warn("[helm] failed to register app event listener:", getErrorMessage(result.reason));
        return [];
      });
      if (disposed) {
        items.forEach((cleanup) => cleanup());
        return;
      }
      cleanups = items;
      const connectionListEpoch = connectionListEpochRef.current;
      void loadStableSnapshot(
        remoteApi.listConnections,
        () => sshEventVersionRef.current,
        () => !disposed && connectionListEpoch === connectionListEpochRef.current,
      ).then((connections) => {
        connections?.forEach((connection) => appEventHandlersRef.current.handleSshStatus(connection));
      }).catch((error) => {
        if (!disposed) console.warn("[helm] failed to list runtime connections:", getErrorMessage(error));
      });
      // 传输事件监听就绪后再补查，查询期间若又有事件，hook 会自动重试到稳定版本。
      void refreshTransferHistory().catch((error) => {
        console.warn("[helm] failed to load transfer history:", getErrorMessage(error));
      });
    });
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [appReady]);

  async function openDatabaseDir() {
    await safeAppAction("打开数据库目录失败", () => appApi.openDatabaseDir());
  }

  async function openPathDir(path: string) {
    await safeAppAction("打开目录失败", () => appApi.openPathDir(path));
  }

  async function openExternalUrl(url: string) {
    await safeAppAction("打开链接失败", () => appApi.openExternalUrl(url));
  }

  async function safeAppAction(errorTitle: string, action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      Modal.error({ title: errorTitle, content: getErrorMessage(error) });
    }
  }

  function applySnapshot(snapshot: ConfigSnapshot, preferredSessionId?: string, preserveRuntime = true) {
    if (!commitConfigSnapshot(snapshot)) return;
    const mappedSessions = snapshot.data.sessions.map(configToRemoteSession);
    const mappedIdSet = new Set(mappedSessions.map((session) => session.id));
    const preferredId = preferredSessionId && mappedIdSet.has(preferredSessionId) ? preferredSessionId : "";
    if (preserveRuntime) {
      setSessions((current) => mergeSnapshotSessions(mappedSessions, current));
    } else {
      setSessions(mappedSessions);
    }
    setOpenSessionIds((current) => {
      const validIds = current.filter((id) => {
        if (mappedIdSet.has(id)) return true;
        const runtimeSession = sessionsRef.current.find((session) => session.id === id);
        return Boolean(runtimeSession && mappedIdSet.has(remoteSessionConfigId(runtimeSession)));
      });
      if (preferredId && !validIds.includes(preferredId)) validIds.push(preferredId);
      return validIds;
    });
    setActiveSessionId((current) => {
      if (preferredId) return preferredId;
      if (mappedIdSet.has(current)) return current;
      const runtimeSession = sessionsRef.current.find((session) => session.id === current);
      return runtimeSession && mappedIdSet.has(remoteSessionConfigId(runtimeSession)) ? current : "";
    });
  }

  function mergeSnapshotSessions(nextSessions: RemoteSession[], currentSessions: RemoteSession[]) {
    const currentById = new Map(currentSessions.map((session) => [session.id, session]));
    const nextById = new Map(nextSessions.map((session) => [session.id, session]));
    const mergedBaseSessions = nextSessions.map((next) => {
      const current = currentById.get(next.id);
      if (!current || current.state === "disconnected") return next;
      return {
        ...next,
        host: current.host,
        username: current.username,
        state: current.state,
        currentPath: current.currentPath,
        loginPath: current.loginPath,
        connectionId: current.connectionId,
        connectedAt: current.connectedAt,
        sshVersion: current.sshVersion,
        terminalId: current.terminalId,
        sftpId: current.sftpId,
        telemetryJobId: current.telemetryJobId,
        connectionNotice: current.connectionNotice,
        terminal: current.terminal,
        telemetry: current.telemetry,
        filesPath: current.filesPath,
        files: current.files,
      };
    });
    const runtimeSessions = currentSessions.flatMap((current) => {
      if (!isRuntimeSession(current)) return [];
      const nextBase = nextById.get(remoteSessionConfigId(current));
      if (!nextBase) return [];
      return [{
        ...current,
        name: nextBase.name,
        groupId: nextBase.groupId,
        accent: nextBase.accent,
        favorite: nextBase.favorite,
        lastConnectedAt: nextBase.lastConnectedAt,
        connectionCount: nextBase.connectionCount,
        createdAt: nextBase.createdAt,
      }];
    });
    return [...mergedBaseSessions, ...runtimeSessions];
  }

  function applyConfigSnapshot(snapshot: ConfigSnapshot) {
    commitConfigSnapshot(snapshot);
  }

  function commitConfigSnapshot(snapshot: ConfigSnapshot) {
    const current = configSnapshotRef.current;
    if (!isConfigSnapshotCurrent(current, snapshot)) return false;
    configSnapshotRef.current = snapshot;
    setConfigSnapshot(snapshot);
    return true;
  }

  async function createSessionGroup(name: string) {
    const snapshot = await vaultApi.groupCreate({ name: name.trim(), parentId: null });
    applyConfigSnapshot(snapshot);
    return snapshot.data.groups[snapshot.data.groups.length - 1]?.id ?? null;
  }

  async function updateSessionGroup(groupId: string, name: string) {
    const snapshot = await vaultApi.groupUpdate(groupId, { name: name.trim(), parentId: null });
    applyConfigSnapshot(snapshot);
  }

  async function deleteSessionGroup(groupId: string) {
    const snapshot = await vaultApi.groupDelete(groupId);
    applySnapshot(snapshot);
    return snapshot.data.groups.find((group) => group.sortOrder === 0)?.id ?? snapshot.data.groups[0]?.id ?? null;
  }

  async function updateSessionFavorite(sessionId: string, favorite: boolean) {
    try {
      applySnapshot(await vaultApi.sessionFavoriteUpdate(sessionId, favorite));
    } catch (error) {
      Modal.error({ title: "更新收藏失败", content: getErrorMessage(error) });
    }
  }

  async function clearSessionRecent(sessionId: string) {
    try {
      applySnapshot(await vaultApi.sessionClearRecent(sessionId));
    } catch (error) {
      Modal.error({ title: "移除最近连接失败", content: getErrorMessage(error) });
    }
  }

  function persistConnectionSectionState(collapsedSectionIds: string[]) {
    const version = connectionSectionSaveVersionRef.current + 1;
    connectionSectionSaveVersionRef.current = version;
    const task = connectionSectionSaveQueueRef.current.then(async () => {
      if (version !== connectionSectionSaveVersionRef.current) return;
      const snapshot = await vaultApi.connectionSectionStateUpdate(collapsedSectionIds);
      if (version === connectionSectionSaveVersionRef.current) applyConfigSnapshot(snapshot);
    });
    connectionSectionSaveQueueRef.current = task.catch(() => undefined);
    return task.catch((error) => {
      if (version === connectionSectionSaveVersionRef.current) {
        Modal.error({ title: "保存分组状态失败", content: getErrorMessage(error) });
      }
      throw error;
    });
  }

  function activateConfigSession(session: RemoteSession) {
    const configId = remoteSessionConfigId(session);
    const relatedSessions = sessionsRef.current.filter((item) => remoteSessionConfigId(item) === configId);
    const target =
      relatedSessions.find((item) => item.id === activeSessionId) ??
      relatedSessions.find((item) => item.connectionId === session.connectionId && item.connectionId) ??
      relatedSessions.find((item) => item.state === "connected") ??
      relatedSessions.find((item) => item.state === "connecting") ??
      relatedSessions.find((item) => item.id === configId);
    if (target) activateSession(target.id);
  }

  function resetRuntimeStateForSnapshot() {
    connectionListEpochRef.current += 1;
    prepareConfigReplacement();
    clearPendingSftpRefreshes();
    sftpListRequestsRef.current.clear();
    resetSessionRuntime();
    resetTerminalRuntime();
    resetTransferHistory();
    resetForwards();
    fileLoadingCountsRef.current.clear();
    setFileLoadingSessionIds(new Set());
  }

  function prepareConfigReplacement() {
    connectionSectionSaveVersionRef.current += 1;
    invalidateAsyncQueues();
    invalidateSettingsMutations();
    setSettingsOpen(false);
    setTunnelOpen(false);
    setAiApiOpen(false);
    closeSessionConfigModal();
  }

  function updateSession(sessionId: string, updater: (session: RemoteSession) => RemoteSession) {
    setSessions((current) => current.map((session) => (session.id === sessionId ? updater(session) : session)));
  }

  function setSessionFilesLoading(sessionId: string, loading: boolean) {
    const counts = fileLoadingCountsRef.current;
    if (loading) {
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    } else {
      const nextCount = (counts.get(sessionId) ?? 0) - 1;
      if (nextCount > 0) {
        counts.set(sessionId, nextCount);
      } else {
        counts.delete(sessionId);
      }
    }
    setFileLoadingSessionIds(new Set(counts.keys()));
  }

  function handleSftpChanged(payload: SftpChangedEvent) {
    const changedDirectory = getRemoteParentPath(payload.path);
    // 事件表示远端变更已经提交。立即切断变更前仍在途的列表 Promise，避免
    // 防抖窗口内的展开或刷新继续复用旧响应。
    invalidateSftpDirectories(payload.sftpId, [changedDirectory]);
    const directories = sftpChangedDirectoriesRef.current.get(payload.sftpId) ?? new Set<string>();
    directories.add(changedDirectory);
    sftpChangedDirectoriesRef.current.set(payload.sftpId, directories);

    const existingTimer = sftpRefreshTimersRef.current.get(payload.sftpId);
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    const timer = window.setTimeout(() => {
      sftpRefreshTimersRef.current.delete(payload.sftpId);
      const changedDirectories = sftpChangedDirectoriesRef.current.get(payload.sftpId) ?? new Set<string>();
      sftpChangedDirectoriesRef.current.delete(payload.sftpId);
      const affected = sessionsRef.current.filter(
        (session) =>
          session.sftpId === payload.sftpId &&
          changedDirectories.has(normalizeRemotePath(remoteSessionPath(session))),
      );
      for (const session of affected) {
        void refreshFiles(payload.sftpId, remoteSessionPath(session), session.id).catch((error) => {
          console.warn("[helm] failed to refresh changed SFTP directory:", getErrorMessage(error));
        });
      }
    }, SFTP_REFRESH_DEBOUNCE_MS);
    sftpRefreshTimersRef.current.set(payload.sftpId, timer);
  }

  function invalidateSftpDirectories(sftpId: string, directories: Iterable<string>) {
    const normalizedDirectories = Array.from(new Set(Array.from(directories, normalizeRemotePath)));
    if (normalizedDirectories.length === 0) return;
    for (const directory of normalizedDirectories) invalidateSftpListRequest(sftpId, directory);
    const changed = new Set(normalizedDirectories);
    setSessions((current) => current.map((session) => (
      session.sftpId === sftpId
        && session.filesPath
        && changed.has(normalizeRemotePath(session.filesPath))
        ? { ...session, filesPath: null }
        : session
    )));
    emitSftpDirectoryInvalidation(sftpId, normalizedDirectories);
  }

  function clearPendingSftpRefreshes() {
    for (const timer of sftpRefreshTimersRef.current.values()) window.clearTimeout(timer);
    sftpRefreshTimersRef.current.clear();
    sftpChangedDirectoriesRef.current.clear();
  }

  sessionWorkspaceActionsRef.current = {
    sendTerminalData,
    sendTerminalCommand,
    resizeTerminal,
    clearTerminal,
    changePath,
    refreshSessionFiles,
    searchRemoteFile,
    listRemoteDirectory,
    runFileOperation,
    uploadLocalFiles,
    downloadRemoteFiles,
    readRemoteText,
    writeRemoteText,
    upsertQuickCommand,
    deleteQuickCommand,
  };

  const currentSettings = configSnapshot?.data.settings ?? { proxy: null, backup: defaultBackupSettings(), quickCommands: [] };
  const quickCommands = currentSettings.quickCommands ?? EMPTY_QUICK_COMMANDS;

  return (
    <AppProviders>
      {/* 主界面始终渲染 */}
      <div className="appShell">
          {appReady ? (
            <Suspense fallback={<AppLoadingFallback />}>
              <>
                <TopBar
                  tabSessions={openSessions}
                  activeSessionId={activeSession?.id ?? ""}
                  onActivate={activateSession}
                  onClose={closeSession}
                  onConnect={(session) => void connectSession(session)}
                  onDisconnect={(session) => void disconnectSession(session)}
                  onCancelConnect={(id) => void cancelConnectingSession(id)}
                  onTransferOpen={() => setTransferCenterOpen(true)}
                  onSettingsOpen={() => setSettingsOpen(true)}
                  connectingSessionIds={connectingSessionIds}
                  transfers={transfers}
                  apiServerRunning={apiServerRunning}
                  apiConfigured={!!currentSettings.aiApiKey}
                  onApiServerStart={() => {
                    setAiApiOpen(true);
                  }}
                />
                {activeSession ? (
                  <main className="workspace">
                    <ConnectionSidebar
                      sessions={sidebarSessions}
                      groups={configSnapshot?.data.groups ?? []}
                      activeSessionId={activeConfigId}
                      connectingSessionIds={connectingSessionIds}
                      onActivate={activateConfigSession}
                      onAdd={() => void addSession()}
                      onEdit={(id) => editSession(id)}
                      onDelete={(id) => void deleteSession(id)}
                      onConnect={(session) => void connectSession(session)}
                      onDisconnect={(session) => void disconnectSession(session)}
                      onCancelConnect={(id) => void cancelConnectingSession(id)}
                      onFavoriteChange={(id, favorite) => void updateSessionFavorite(id, favorite)}
                      onClearRecent={(id) => void clearSessionRecent(id)}
                      collapsedSectionIds={configSnapshot?.data.settings.collapsedConnectionSectionIds ?? []}
                      onCollapsedSectionIdsChange={persistConnectionSectionState}
                    />
                    <section className="sessionWorkspaceLayer">
                      {openSessions.map((session) => (
                        <SessionWorkspace
                          key={session.id}
                          session={session}
                          active={session.id === activeSession.id}
                          filesLoading={fileLoadingSessionIds.has(session.id)}
                          quickCommands={quickCommands}
                          scrollback={TERMINAL_SCROLLBACK}
                          webglEnabled={TERMINAL_WEBGL_ENABLED}
                          actionsRef={sessionWorkspaceActionsRef}
                        />
                      ))}
                    </section>
                  </main>
                ) : (
                  <main className="workspace workspace-empty">
                    <ConnectionSidebar
                      sessions={sidebarSessions}
                      groups={configSnapshot?.data.groups ?? []}
                      activeSessionId=""
                      connectingSessionIds={connectingSessionIds}
                      onActivate={activateConfigSession}
                      onAdd={() => void addSession()}
                      onEdit={(id) => editSession(id)}
                      onDelete={(id) => void deleteSession(id)}
                      onConnect={(session) => void connectSession(session)}
                      onDisconnect={(session) => void disconnectSession(session)}
                      onCancelConnect={(id) => void cancelConnectingSession(id)}
                      onFavoriteChange={(id, favorite) => void updateSessionFavorite(id, favorite)}
                      onClearRecent={(id) => void clearSessionRecent(id)}
                      collapsedSectionIds={configSnapshot?.data.settings.collapsedConnectionSectionIds ?? []}
                      onCollapsedSectionIdsChange={persistConnectionSectionState}
                    />
                    <EmptyWorkspace
                      sessionCount={configSessions.length}
                      onAddSession={() => void addSession()}
                    />
                  </main>
                )}
                <AppStatusBar
                  activeSession={activeSession}
                  sessions={sessions}
                  connectingSessionIds={connectingSessionIds}
                />
              </>
            </Suspense>
          ) : (
            <AppLoadingFallback error={bootstrapError} />
          )}
      </div>

      {/* 一次性数据迁移弹窗 */}
      <MigrationGate
        open={migrationNeeded}
        loading={migrationBusy}
        error={migrationError}
        onMigrate={handleMigrate}
        onSkip={handleSkipMigration}
      />

      {appReady && (
          <Suspense fallback={null}>
            <TransferCenter
              open={transferCenterOpen}
              transfers={transfers}
              sessions={sessions}
              saveRecords={fileSaveRecords}
              backupRecords={[...(configSnapshot?.data.backupRecords ?? [])]
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())}
              canUpload={Boolean(activeSession?.sftpId)}
              onClose={() => setTransferCenterOpen(false)}
              onPause={(id) => void pauseTransfer(id)}
              onResume={(id) => void resumeTransfer(id)}
              onCancel={(id) => void cancelTransfer(id)}
              onRetry={(id) => void retryTransfer(id)}
              onRemove={(id) => void removeTransfer(id)}
              onRetrySave={(id) => void retryFileSaveRecord(id)}
              onRemoveSave={removeFileSaveRecord}
              onRestoreBackup={restoreBackupRecord}
              onRemoveBackup={(id) => deleteBackupRecord(id, false)}
              onClear={async () => {
                try {
                  await Promise.all([
                    clearFinishedTransferHistory(),
                    clearBackupRecords(),
                  ]);
                  clearFileSaveRecords();
                } catch (error) {
                  Modal.error({ title: "清理传输记录失败", content: getErrorMessage(error) });
                  throw error;
                }
              }}
              onUploadFiles={(paths) => {
                if (activeSession) {
                  void uploadLocalFiles(activeSession.id, paths, activeSession.currentPath).catch((error) => {
                    Modal.error({ title: "上传文件失败", content: getErrorMessage(error) });
                  });
                }
              }}
              onOpenDir={(dir) => void openPathDir(dir)}
            />
          </Suspense>
      )}
      {configSnapshot && (
          <Suspense fallback={null}>
            <BackupModal
              open={backupOpen}
              busy={backupBusy}
              settings={currentSettings}
              records={configSnapshot.data.backupRecords ?? []}
              onClose={() => setBackupOpen(false)}
              onExport={exportBackup}
              onImport={importBackup}
              onSettingsSave={saveBackupSettings}
              onRunNow={() => runConfiguredBackup()}
              onRestoreRecord={restoreBackupRecord}
              onDeleteRecord={deleteBackupRecord}
            />
            <SettingsModal
              open={settingsOpen}
              initialValue={currentSettings}
              sessions={configSessions}
              onClose={() => setSettingsOpen(false)}
              onSubmit={saveSettings}
              onBackupOpen={() => setBackupOpen(true)}
              onTunnelOpen={() => setTunnelOpen(true)}
              onCreateSession={(onCreated) => addSession(onCreated)}
              onApiServerChange={setApiServerRunning}
              onSettingsChange={applyConfigSnapshot}
              aiApiOpen={aiApiOpen}
              onAiApiOpenChange={setAiApiOpen}
              appInfo={appInfo}
              updateInfo={updateInfo}
              updateError={updateError}
              updateChecking={updateChecking}
              updateDownloading={updateDownloading}
              downloadedUpdatePath={downloadedUpdatePath}
              updateRepo={appApi.updateRepo()}
              onCheckUpdate={checkForUpdate}
              onDownloadUpdate={downloadUpdate}
              onInstallUpdate={installUpdate}
              onIgnoreUpdate={ignoreUpdateVersion}
              onOpenDatabaseDir={openDatabaseDir}
              onOpenPathDir={openPathDir}
              onOpenExternalUrl={openExternalUrl}
            />
            <TunnelDrawer
              open={tunnelOpen}
              sessions={configSessions}
              tunnels={configSnapshot.data.tunnels ?? []}
              forwards={forwards}
              onClose={() => setTunnelOpen(false)}
              onCreate={createTunnel}
              onUpdate={updateTunnel}
              onDelete={deleteTunnel}
              onStart={startTunnel}
              onStop={stopTunnel}
            />
          </Suspense>
      )}
      {configSnapshot && sessionModal && (
          <Suspense fallback={null}>
            <SessionConfigModal
              open
              requestId={sessionModal.requestId}
              mode={sessionModal.mode}
              initialValue={sessionModal.input}
              groups={configSnapshot.data.groups}
              existingSessions={configSnapshot.data.sessions.map((s) => ({ id: s.id, name: s.name, host: s.host }))}
              editingSessionId={sessionModal.mode === "edit" ? sessionModal.sessionId : undefined}
              onCancel={closeSessionConfigModal}
              onCreateGroup={createSessionGroup}
              onUpdateGroup={updateSessionGroup}
              onDeleteGroup={deleteSessionGroup}
              onSubmit={saveSessionConfig}
            />
          </Suspense>
      )}
    </AppProviders>
  );
}

export default App;

function sessionForSidebar(configSession: RemoteSession, sessions: RemoteSession[], activeSessionId: string): RemoteSession {
  const related = sessions.filter((session) => remoteSessionConfigId(session) === configSession.id);
  const activeRelated = related.find((session) => session.id === activeSessionId);
  const connecting = related.find((session) => session.state === "connecting");
  const connected = activeRelated?.state === "connected"
    ? activeRelated
    : related.find((session) => session.state === "connected");
  const source = connecting ?? connected;
  if (!source) return configSession;
  return {
    ...configSession,
    state: source.state,
    connectionId: source.connectionId,
    connectedAt: source.connectedAt,
    sshVersion: source.sshVersion,
    terminalId: source.terminalId,
    sftpId: source.sftpId,
    telemetryJobId: source.telemetryJobId,
    currentPath: source.currentPath,
    loginPath: source.loginPath,
  };
}
