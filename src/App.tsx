import { Modal } from "antd";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { FileManager } from "./components/FileManager";
import { MigrationGate } from "./components/MigrationGate";
import { SessionConfigModal } from "./components/SessionConfigModal";
import { SplitPane } from "./components/SplitPane";
import { TelemetrySidebar } from "./components/TelemetrySidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { TopBar } from "./components/TopBar";
import { EmptyWorkspace } from "./components/shared/EmptyWorkspace";
import { configToRemoteSession, getErrorMessage } from "./lib/configMapping";
import { getParentPath as getRemoteParentPath, normalizePath as normalizeRemotePath } from "./lib/path";
import { isRuntimeSession, remoteSessionConfigId } from "./lib/session";
import { TERMINAL_SCROLLBACK, TERMINAL_WEBGL_ENABLED } from "./lib/performanceDefaults";
import type {
  ConfigSnapshot,
  RemoteFileEntry,
  RemoteSession,
  SftpChangedEvent,
} from "./types";

const SFTP_REFRESH_DEBOUNCE_MS = 120;

function App() {
  const [configSnapshot, setConfigSnapshot] = useState<ConfigSnapshot>();
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
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
  const [fileLoadingSessionIds, setFileLoadingSessionIds] = useState<Set<string>>(new Set());
  const sessionsRef = useRef<RemoteSession[]>([]);
  const configSnapshotRef = useRef<ConfigSnapshot | undefined>(configSnapshot);
  const autoSftpConnectionKeysRef = useRef<Set<string>>(new Set());
  const fileLoadingCountsRef = useRef<Map<string, number>>(new Map());
  const sftpListRequestsRef = useRef<Map<string, Promise<RemoteFileEntry[]>>>(new Map());
  const sftpRefreshTimersRef = useRef<Map<string, number>>(new Map());
  const sftpChangedDirectoriesRef = useRef<Map<string, Set<string>>>(new Map());
  const listSftpFiles = useCallback((sftpId: string, path: string) => {
    const normalizedPath = normalizeRemotePath(path);
    const requestKey = `${sftpId}:${normalizedPath}`;
    const existing = sftpListRequestsRef.current.get(requestKey);
    if (existing) return existing;
    const request = remoteApi.listFiles(sftpId, normalizedPath).finally(() => {
      if (sftpListRequestsRef.current.get(requestKey) === request) {
        sftpListRequestsRef.current.delete(requestKey);
      }
    });
    sftpListRequestsRef.current.set(requestKey, request);
    return request;
  }, []);
  const {
    apiServerRunning,
    setApiServerRunning,
    initializeApiServerRuntime,
  } = useApiServerRuntime(configSnapshotRef);
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
    applySnapshot,
    initializeApiServerRuntime,
  });
  const {
    forwards,
    upsertForward,
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
    saveQuickCommands,
  } = useSettingsPersistence({
    configSnapshot,
    applyConfigSnapshot,
    onSettingsSaved: () => setSettingsOpen(false),
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
    refreshActiveFiles,
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
  } = useBackupWorkflow({
    applySnapshot,
    applyConfigSnapshot,
    resetRuntimeState: resetRuntimeStateForSnapshot,
  });
  useTrayActions({
    appReady,
    onOpenSettings: () => setSettingsOpen(true),
    onOpenBackup: () => setBackupOpen(true),
    onRunBackup: () => void runConfiguredBackup(),
  });

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    configSnapshotRef.current = configSnapshot;
  }, [configSnapshot]);

  useEffect(() => () => clearPendingSftpRefreshes(), []);

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

  useEffect(() => {
    if (!appReady) return;
    void refreshTransferHistory().catch((error) => {
      console.warn("[helm] failed to load transfer history:", getErrorMessage(error));
    });
  }, [appReady]);

  useEffect(() => {
    if (!appReady) return;
    let disposed = false;
    let cleanups: Array<() => void> = [];
    void Promise.allSettled([
      remoteApi.onSshStatus(handleSshStatus),
      remoteApi.onSftpChanged(handleSftpChanged),
      remoteApi.onTerminalOutput(handleTerminalOutput),
      remoteApi.onTerminalClosed(handleTerminalClosed),
      remoteApi.onTelemetrySnapshot((payload) => {
        if (!payload.snapshot) return;
        setSessions((current) =>
          current.map((session) =>
            session.id === payload.sessionId
              ? { ...session, telemetry: payload.snapshot }
              : session,
          ),
        );
      }),
      remoteApi.onTransferProgress(upsertTransfer),
      remoteApi.onTransferCompleted((payload) => {
        upsertTransfer(payload);
        void refreshFilesForTransfer(payload);
      }),
      remoteApi.onTransferFailed(upsertTransfer),
      appEvents.onConfigChanged(applyConfigSnapshot),
      remoteApi.onForwardStatus(upsertForward),
      remoteApi.onHostKeyVerify((payload) => {
        appendTerminal(payload.sessionId, "system", `主机密钥待确认：${payload.fingerprint}`);
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
    const mappedSessions = snapshot.data.sessions.map(configToRemoteSession);
    const mappedIdSet = new Set(mappedSessions.map((session) => session.id));
    const preferredId = preferredSessionId && mappedIdSet.has(preferredSessionId) ? preferredSessionId : "";
    configSnapshotRef.current = snapshot;
    setConfigSnapshot(snapshot);
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
        state: current.state,
        currentPath: current.currentPath,
        loginPath: current.loginPath,
        connectionId: current.connectionId,
        connectedAt: current.connectedAt,
        sshVersion: current.sshVersion,
        terminalId: current.terminalId,
        sftpId: current.sftpId,
        telemetryJobId: current.telemetryJobId,
        terminal: current.terminal,
        telemetry: current.telemetry,
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
        host: nextBase.host,
        username: nextBase.username,
        accent: nextBase.accent,
        favorite: nextBase.favorite,
        lastConnectedAt: nextBase.lastConnectedAt,
      }];
    });
    return [...mergedBaseSessions, ...runtimeSessions];
  }

  function applyConfigSnapshot(snapshot: ConfigSnapshot) {
    configSnapshotRef.current = snapshot;
    setConfigSnapshot(snapshot);
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

  async function markSessionRecent(sessionId: string) {
    try {
      applySnapshot(await vaultApi.sessionMarkRecent(sessionId));
    } catch (error) {
      console.warn("[helm] failed to mark recent session:", getErrorMessage(error));
    }
  }

  async function clearSessionRecent(sessionId: string) {
    try {
      applySnapshot(await vaultApi.sessionClearRecent(sessionId));
    } catch (error) {
      Modal.error({ title: "移除最近连接失败", content: getErrorMessage(error) });
    }
  }

  async function connectSessionWithRecent(session: RemoteSession) {
    void markSessionRecent(remoteSessionConfigId(session));
    await connectSession(session);
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
    clearPendingSftpRefreshes();
    resetSessionRuntime();
    resetTerminalRuntime();
    resetTransferHistory();
    resetForwards();
    fileLoadingCountsRef.current.clear();
    setFileLoadingSessionIds(new Set());
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
    const directories = sftpChangedDirectoriesRef.current.get(payload.sftpId) ?? new Set<string>();
    directories.add(getRemoteParentPath(payload.path));
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
        void refreshFiles(payload.sftpId, remoteSessionPath(session), session.id);
      }
    }, SFTP_REFRESH_DEBOUNCE_MS);
    sftpRefreshTimersRef.current.set(payload.sftpId, timer);
  }

  function clearPendingSftpRefreshes() {
    for (const timer of sftpRefreshTimersRef.current.values()) window.clearTimeout(timer);
    sftpRefreshTimersRef.current.clear();
    sftpChangedDirectoriesRef.current.clear();
  }

  const currentSettings = configSnapshot?.data.settings ?? { proxy: null, backup: defaultBackupSettings(), quickCommands: [] };

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
                  onConnect={(session) => void connectSessionWithRecent(session)}
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
                      onConnect={(session) => void connectSessionWithRecent(session)}
                      onDisconnect={(session) => void disconnectSession(session)}
                      onCancelConnect={(id) => void cancelConnectingSession(id)}
                      onFavoriteChange={(id, favorite) => void updateSessionFavorite(id, favorite)}
                      onMarkRecent={(id) => void markSessionRecent(id)}
                      onClearRecent={(id) => void clearSessionRecent(id)}
                    />
                    <section className="mainSurface">
                      <SplitPane
                        minTop={240}
                        minBottom={220}
                        top={
                          <div className="terminalLayer">
                            {openSessions.map((sess) => (
                              <div
                                key={sess.id}
                                className="terminalSlot"
                                style={{ display: sess.id === activeSession.id ? "block" : "none" }}
                              >
                                <TerminalPanel
                                  session={sess}
                                  scrollback={TERMINAL_SCROLLBACK}
                                  webglEnabled={TERMINAL_WEBGL_ENABLED}
                                  onSendData={(data) => void sendTerminalData(sess.id, sess.terminalId, data)}
                                  onResize={(cols, rows) => void resizeTerminal(sess.terminalId, cols, rows)}
                                  onClear={() => clearTerminal(sess.id)}
                                />
                              </div>
                            ))}
                          </div>
                        }
                        bottom={
                          <FileManager
                            session={activeSession}
                            onPathChange={(path) => void changePath(path)}
                            onRefresh={refreshActiveFiles}
                            onRemoteSearch={searchRemoteFile}
                            onListDirectory={listRemoteDirectory}
                            onFileOperation={runFileOperation}
                            onUploadFiles={uploadLocalFiles}
                            onDownloadFiles={downloadRemoteFiles}
                            onReadText={readRemoteText}
                            onWriteText={writeRemoteText}
                            onSendCommand={(command) => sendTerminalCommand(activeSession.id, activeSession.terminalId, command)}
                            quickCommands={currentSettings.quickCommands ?? []}
                            onQuickCommandsChange={saveQuickCommands}
                            filesLoading={fileLoadingSessionIds.has(activeSession.id)}
                          />
                        }
                      />
                    </section>
                    <TelemetrySidebar session={activeSession} />
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
                      onConnect={(session) => void connectSessionWithRecent(session)}
                      onDisconnect={(session) => void disconnectSession(session)}
                      onCancelConnect={(id) => void cancelConnectingSession(id)}
                      onFavoriteChange={(id, favorite) => void updateSessionFavorite(id, favorite)}
                      onMarkRecent={(id) => void markSessionRecent(id)}
                      onClearRecent={(id) => void clearSessionRecent(id)}
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
              backupRecords={(() => {
                const records = configSnapshot?.data.backupRecords ?? [];
                if (records.length === 0) return [];
                const sorted = [...records].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                return sorted.slice(0, 1);
              })()}
              canUpload={Boolean(activeSession?.sftpId)}
              onClose={() => setTransferCenterOpen(false)}
              onPause={(id) => void pauseTransfer(id)}
              onResume={(id) => void resumeTransfer(id)}
              onCancel={(id) => void cancelTransfer(id)}
              onRetry={(id) => void retryTransfer(id)}
              onRemove={(id) => void removeTransfer(id)}
              onRetrySave={(id) => void retryFileSaveRecord(id)}
              onRemoveSave={removeFileSaveRecord}
              onRestoreBackup={(id) => void restoreBackupRecord(id)}
              onRemoveBackup={(id) => void deleteBackupRecord(id, false)}
              onClear={() => {
                void clearFinishedTransferHistory();
                clearFileSaveRecords();
                void vaultApi.backupRecordsClear().then(applyConfigSnapshot);
              }}
              onUploadFiles={(paths) => void uploadLocalFiles(paths, activeSession?.currentPath ?? "/")}
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
