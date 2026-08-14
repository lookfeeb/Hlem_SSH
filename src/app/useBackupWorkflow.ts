import { useRef, useState } from "react";
import { vaultApi } from "../api/vaultApi";
import { createExclusiveAsyncRunner } from "../lib/exclusiveAsync";
import { useMountedRef } from "../lib/reactLifecycle";
import type { BackupSettings, ConfigSnapshot } from "../types";

type UseBackupWorkflowOptions = {
  applySnapshot: (snapshot: ConfigSnapshot, preferredSessionId?: string, preserveRuntime?: boolean) => void;
  applyConfigSnapshot: (snapshot: ConfigSnapshot) => void;
  resetRuntimeState: () => void;
  prepareConfigReplacement: () => void;
};

export function useBackupWorkflow({
  applySnapshot,
  applyConfigSnapshot,
  resetRuntimeState,
  prepareConfigReplacement,
}: UseBackupWorkflowOptions) {
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const operationRunnerRef = useRef(createExclusiveAsyncRunner("另一项备份操作正在进行，请稍候"));
  const mountedRef = useMountedRef();

  function runBackupOperation<T>(operation: () => Promise<T>) {
    return operationRunnerRef.current.run(async () => {
      setBackupBusy(true);
      try {
        return await operation();
      } finally {
        if (mountedRef.current) setBackupBusy(false);
      }
    });
  }

  async function exportBackup(path: string) {
    await runBackupOperation(() => vaultApi.backupExport(path));
  }

  async function importBackup(path: string) {
    await loadBackupSnapshot(() => vaultApi.backupImport(path));
  }

  async function restoreBackupRecord(recordId: string) {
    await loadBackupSnapshot(() => vaultApi.backupRecordRestore(recordId));
  }

  async function loadBackupSnapshot(loader: () => Promise<ConfigSnapshot>) {
    await runBackupOperation(async () => {
      prepareConfigReplacement();
      const snapshot = await loader();
      if (!mountedRef.current) return;
      resetRuntimeState();
      applySnapshot(snapshot, undefined, false);
      setBackupOpen(false);
    });
  }

  async function saveBackupSettings(settings: BackupSettings) {
    await runBackupOperation(async () => {
      const snapshot = await vaultApi.settingsBackupUpdate(settings);
      if (!mountedRef.current) return;
      applyConfigSnapshot(snapshot);
    });
  }

  async function runConfiguredBackup() {
    await runBackupOperation(async () => {
      const snapshot = await vaultApi.backupRunNow();
      if (!mountedRef.current) return;
      applyConfigSnapshot(snapshot);
    });
  }

  async function deleteBackupRecord(recordId: string, deleteFile: boolean) {
    await runBackupOperation(async () => {
      const snapshot = await vaultApi.backupRecordDelete(recordId, deleteFile);
      if (!mountedRef.current) return;
      applyConfigSnapshot(snapshot);
    });
  }

  async function clearBackupRecords() {
    await runBackupOperation(async () => {
      const snapshot = await vaultApi.backupRecordsClear();
      if (!mountedRef.current) return;
      applyConfigSnapshot(snapshot);
    });
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
    clearBackupRecords,
  };
}
