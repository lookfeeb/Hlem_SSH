import { Modal } from "antd";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { appApi } from "./api/appApi";
import { remoteApi } from "./api/remoteApi";
import { defaultBackupSettings, vaultApi } from "./api/vaultApi";
import {
  BackupModal,
  FileManager,
  SettingsModal,
  SessionConfigModal,
  SplitPane,
  TelemetrySidebar,
  TerminalPanel,
  TopBar,
  TransferCenter,
  TunnelDrawer,
  preloadWorkspaceComponents,
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
import { useTerminalRuntime } from "./app/useTerminalRuntime";
import { useTrayActions } from "./app/useTrayActions";
import { useTransferActions } from "./app/useTransferActions";
import { useTransferHistory } from "./app/useTransferHistory";
import { useTunnelRuntime } from "./app/useTunnelRuntime";
import { AppLoadingFallback } from "./components/shared/AppLoadingFallback";
import { AppProviders } from "./components/shared/AppProviders";
import { MigrationGate } from "./components/MigrationGate";
import { configToRemoteSession, getErrorMessage } from "./lib/configMapping";
import type {
  ConfigSnapshot,
  RemoteSession,
  SftpChangedEvent,
} from "./types";

function App() {
  const [configSnapshot, setConfigSnapshot] = useState<ConfigSnapshot>();
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [openSessionIds, setOpenSessionIds] = useState<string[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [sessionListOpen, setSessionListOpen] = useState(false);
  const [transferCenterOpen, setTransferCenterOpen] = useState(false);
  const {
    transfers,
    transfersRef,
    transferSessionIds,
    transferSessionIdsRef,
    setPersistedTransfers,
    setPersistedTransferSessionIds,
    resetTransferHistory,
    clearFinishedTransferHistory,
  } = useTransferHistory();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tunnelOpen, setTunnelOpen] = useState(false);
  const [aiApiOpen, setAiApiOpen] = useState(false);
  const [fileLoadingSessionIds, setFileLoadingSessionIds] = useState<Set<string>>(new Set());
  const sessionsRef = useRef<RemoteSession[]>([]);
  const configSnapshotRef = useRef<ConfigSnapshot | undefined>(configSnapshot);
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
    consumePendingTerminalEntries,
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
  });
  const {
    upsertTransfer,
    rememberTransferTarget,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    retryTransfer,
    removeTransfer,
  } = useTransferActions({
    sessionsRef,
    transfersRef,
    transferSessionIdsRef,
    setPersistedTransfers,
    setPersistedTransferSessionIds,
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
  const {
    sessionModal,
    returnToSessionListOnCancel,
    addSession,
    editSession,
    saveSessionConfig,
    closeSessionConfigModal,
    backToSessionListFromConfig,
  } = useSessionConfigWorkflow({
    configSnapshot,
    activeSessionId,
    applySnapshot,
    openSessionList: () => setSessionListOpen(true),
  });
  const openSessions = useMemo(
    () => openSessionIds.map((id) => sessions.find((session) => session.id === id)).filter(Boolean) as RemoteSession[],
    [openSessionIds, sessions],
  );
  const activeSession = useMemo(
    () => openSessions.find((session) => session.id === activeSessionId) ?? openSessions[0],
    [activeSessionId, openSessions],
  );
  const {
    openSftpWithFiles,
    changePath,
    refreshActiveFiles,
    runFileOperation,
    uploadLocalFiles,
    downloadRemoteFile,
    downloadRemoteFiles,
    readRemoteText,
    writeRemoteTextRaw,
    refreshFiles,
    refreshFilesForTransfer,
    searchRemoteFile,
    listRemoteDirectory,
  } = useSftpFiles({
    activeSession,
    sessionsRef,
    updateSession,
    setSessionFilesLoading,
    appendTerminal: (sessionId, kind, content) => appendTerminal(sessionId, kind, content),
    formatSessionError,
    upsertTransfer,
    rememberTransferTarget,
    openTransferCenter: () => setTransferCenterOpen(true),
  });
  const {
    connectingSessionId,
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
    openSftpWithFiles,
    rememberTransferTarget,
    appendTerminal: (sessionId, kind, content) => appendTerminal(sessionId, kind, content),
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
    appReady,
    configSnapshot,
    configSnapshotRef,
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

  useEffect(() => {
    if (!appReady) return;
    let disposed = false;
    let cleanups: Array<() => void> = [];
    void Promise.all([
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
      remoteApi.onForwardStatus(upsertForward),
      remoteApi.onHostKeyVerify((payload) => {
        appendTerminal(payload.sessionId, "system", `主机密钥待确认：${payload.fingerprint}`);
      }),
    ]).then((items) => {
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

  useEffect(() => {
    if (!appReady) return;
    if (sessionModal || activeSession) return;
    if (openSessionIds.length > 0) return;
    setSessionListOpen(true);
  }, [appReady, sessionModal, activeSession, openSessionIds.length]);

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
    const mappedIds = mappedSessions.map((session) => session.id);
    const preferredId = preferredSessionId && mappedIds.includes(preferredSessionId) ? preferredSessionId : "";
    configSnapshotRef.current = snapshot;
    setConfigSnapshot(snapshot);
    if (preserveRuntime) {
      setSessions((current) => mergeSnapshotSessions(mappedSessions, current));
    } else {
      setSessions(mappedSessions);
    }
    setOpenSessionIds((current) => {
      const validIds = current.filter((id) => mappedIds.includes(id));
      if (preferredId && !validIds.includes(preferredId)) validIds.push(preferredId);
      return validIds;
    });
    setActiveSessionId((current) => (preferredId || (mappedIds.includes(current) ? current : "")));
    preloadWorkspaceComponents();
  }

  function mergeSnapshotSessions(nextSessions: RemoteSession[], currentSessions: RemoteSession[]) {
    const currentById = new Map(currentSessions.map((session) => [session.id, session]));
    return nextSessions.map((next) => {
      const current = currentById.get(next.id);
      if (!current || current.state === "disconnected") return next;
      return {
        ...next,
        state: current.state,
        currentPath: current.currentPath,
        connectionId: current.connectionId,
        terminalId: current.terminalId,
        sftpId: current.sftpId,
        telemetryJobId: current.telemetryJobId,
        terminal: current.terminal,
        telemetry: current.telemetry,
        files: current.files,
      };
    });
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

  function resetRuntimeStateForSnapshot() {
    resetSessionRuntime();
    resetTerminalRuntime();
    resetTransferHistory();
    resetForwards();
    setFileLoadingSessionIds(new Set());
  }

  function updateSession(sessionId: string, updater: (session: RemoteSession) => RemoteSession) {
    setSessions((current) => current.map((session) => (session.id === sessionId ? updater(session) : session)));
  }

  function setSessionFilesLoading(sessionId: string, loading: boolean) {
    setFileLoadingSessionIds((current) => {
      const next = new Set(current);
      if (loading) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  }

  function handleSftpChanged(payload: SftpChangedEvent) {
    const affected = sessionsRef.current.filter((session) => session.sftpId === payload.sftpId);
    for (const session of affected) {
      void refreshFiles(payload.sftpId, remoteSessionPath(session), session.id);
    }
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
                  sessions={sessions}
                  groups={configSnapshot?.data.groups ?? []}
                  tabSessions={openSessions}
                  activeSessionId={activeSession?.id ?? ""}
                  onActivate={activateSession}
                  onAdd={() => void addSession(true)}
                  onClose={closeSession}
                  onEdit={(id) => editSession(id, true)}
                  onDelete={(id) => void deleteSession(id)}
                  onConnect={(session) => void connectSession(session)}
                  onDisconnect={(session) => void disconnectSession(session)}
                  onCancelConnect={(id) => void cancelConnectingSession(id)}
                  onTransferOpen={() => setTransferCenterOpen(true)}
                  onSettingsOpen={() => setSettingsOpen(true)}
                  connectingSessionId={connectingSessionId}
                  transfers={transfers}
                  sessionListOpen={sessionListOpen}
                  onSessionListOpenChange={setSessionListOpen}
                  apiServerRunning={apiServerRunning}
                  apiConfigured={!!currentSettings.aiApiKey}
                  onApiServerStart={() => {
                    setAiApiOpen(true);
                  }}
                />
                {activeSession ? (
                  <main className="workspace">
                    <TelemetrySidebar session={activeSession} />
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
                            onDownloadFile={downloadRemoteFile}
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
                  </main>
                ) : null}
              </>
            </Suspense>
          ) : (
            <div className="appPlaceholder" />
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
              transferSessionIds={transferSessionIds}
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
                clearFinishedTransferHistory();
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
              sessions={sessions}
              onClose={() => setSettingsOpen(false)}
              onSubmit={saveSettings}
              onBackupOpen={() => setBackupOpen(true)}
              onTunnelOpen={() => setTunnelOpen(true)}
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
              sessions={sessions}
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
              onCancelButton={returnToSessionListOnCancel ? backToSessionListFromConfig : undefined}
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
