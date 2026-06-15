import { useState } from "react";
import { vaultApi } from "../api/vaultApi";
import { useMountedRef } from "../lib/reactLifecycle";
import type { AppSettings, ConfigSnapshot } from "../types";

type UseBackupWorkflowOptions = {
  applySnapshot: (snapshot: ConfigSnapshot, preferredSessionId?: string, preserveRuntime?: boolean) => void;
  applyConfigSnapshot: (snapshot: ConfigSnapshot) => void;
  resetRuntimeState: () => void;
};

export function useBackupWorkflow({
  applySnapshot,
  applyConfigSnapshot,
  resetRuntimeState,
}: UseBackupWorkflowOptions) {
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const mountedRef = useMountedRef();

  async function exportBackup(path: string) {
    setBackupBusy(true);
    try {
      await vaultApi.backupExport(path);
    } finally {
      if (mountedRef.current) setBackupBusy(false);
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

  async function runConfiguredBackup() {
    setBackupBusy(true);
    try {
      const snapshot = await vaultApi.backupRunNow();
      if (!mountedRef.current) return;
      applyConfigSnapshot(snapshot);
    } finally {
      if (mountedRef.current) setBackupBusy(false);
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
