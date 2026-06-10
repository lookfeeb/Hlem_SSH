import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { defaultBackupSettings, vaultApi } from "../api/vaultApi";
import { autoBackupDueTargetKinds } from "./appHelpers";
import { useMountedRef } from "../lib/reactLifecycle";
import type { AppSettings, ConfigSnapshot } from "../types";

type UseBackupWorkflowOptions = {
  appReady: boolean;
  configSnapshot: ConfigSnapshot | undefined;
  configSnapshotRef: MutableRefObject<ConfigSnapshot | undefined>;
  applySnapshot: (snapshot: ConfigSnapshot, preferredSessionId?: string, preserveRuntime?: boolean) => void;
  applyConfigSnapshot: (snapshot: ConfigSnapshot) => void;
  resetRuntimeState: () => void;
};

export function useBackupWorkflow({
  appReady,
  configSnapshot,
  configSnapshotRef,
  applySnapshot,
  applyConfigSnapshot,
  resetRuntimeState,
}: UseBackupWorkflowOptions) {
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const autoBackupRunningRef = useRef(false);
  const mountedRef = useMountedRef();

  useEffect(() => {
    const snapshot = configSnapshot;
    if (!appReady || !snapshot) return;
    const backup = snapshot.data.settings?.backup ?? defaultBackupSettings();
    if (backup.frequency === "manual") return;
    const check = () => {
      const current = configSnapshotRef.current;
      if (!current || autoBackupRunningRef.current) return;
      const dueTargetKinds = autoBackupDueTargetKinds(backup, current.data.backupRecords ?? []);
      if (dueTargetKinds.length > 0) {
        void runConfiguredBackup(false, dueTargetKinds);
      }
    };
    const startupTimer = window.setTimeout(check, 3000);
    const interval = window.setInterval(check, 60_000);
    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
    };
  }, [configSnapshot?.data.settings?.backup, configSnapshot?.data.backupRecords, appReady]);

  async function exportBackup(path: string) {
    setBackupBusy(true);
    try {
      await vaultApi.backupExport(path);
    } finally {
      setBackupBusy(false);
    }
  }

  async function importBackup(path: string) {
    await loadBackupSnapshot(() => vaultApi.backupImport(path));
  }

  async function restoreBackupRecord(recordId: string) {
    await loadBackupSnapshot(() => vaultApi.backupRecordRestore(recordId));
  }

  async function loadBackupSnapshot(loader: () => Promise<ConfigSnapshot>) {
    setBackupBusy(true);
    try {
      const snapshot = await loader();
      if (!mountedRef.current) return;
      resetRuntimeState();
      applySnapshot(snapshot, undefined, false);
      setBackupOpen(false);
    } finally {
      if (mountedRef.current) setBackupBusy(false);
    }
  }

  async function saveBackupSettings(settings: AppSettings) {
    const snapshot = await vaultApi.settingsUpdate(settings);
    if (!mountedRef.current) return;
    applyConfigSnapshot(snapshot);
  }

  async function runConfiguredBackup(showBusy = true, autoTargetKinds?: string[]) {
    if (autoBackupRunningRef.current) return;
    autoBackupRunningRef.current = true;
    if (showBusy) setBackupBusy(true);
    try {
      const snapshot = autoTargetKinds?.length
        ? await vaultApi.backupRunAuto(autoTargetKinds)
        : await vaultApi.backupRunNow();
      if (!mountedRef.current) return;
      applyConfigSnapshot(snapshot);
    } finally {
      autoBackupRunningRef.current = false;
      if (showBusy && mountedRef.current) setBackupBusy(false);
    }
  }

  async function deleteBackupRecord(recordId: string, deleteFile: boolean) {
    const snapshot = await vaultApi.backupRecordDelete(recordId, deleteFile);
    if (!mountedRef.current) return;
    applyConfigSnapshot(snapshot);
  }

  return {
    backupOpen,
    setBackupOpen,
    backupBusy,
    exportBackup,
    importBackup,
    restoreBackupRecord,
    saveBackupSettings,
    runConfiguredBackup,
    deleteBackupRecord,
  };
}
