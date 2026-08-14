import { vaultApi } from "../api/vaultApi";
import { useRef } from "react";
import { createAsyncQueue, isAsyncQueueInvalidatedError } from "../lib/asyncQueue";
import { useMountedRef } from "../lib/reactLifecycle";
import type { AppProxyOptions, ConfigSnapshot, QuickCommand } from "../types";

type UseSettingsPersistenceOptions = {
  applyConfigSnapshot: (snapshot: ConfigSnapshot) => void;
};

export function useSettingsPersistence({
  applyConfigSnapshot,
}: UseSettingsPersistenceOptions) {
  const mountedRef = useMountedRef();
  const quickCommandQueueRef = useRef(createAsyncQueue());

  async function saveSettings(proxy: AppProxyOptions | null) {
    const snapshot = await vaultApi.settingsProxyUpdate(proxy);
    if (!mountedRef.current) return;
    applyConfigSnapshot(snapshot);
  }

  async function upsertQuickCommand(command: QuickCommand) {
    return quickCommandQueueRef.current.enqueue(async () => {
      const snapshot = await vaultApi.quickCommandUpsert(command);
      if (mountedRef.current) applyConfigSnapshot(snapshot);
    }).catch((error) => {
      if (isAsyncQueueInvalidatedError(error)) return;
      throw error;
    });
  }

  async function deleteQuickCommand(commandId: string) {
    return quickCommandQueueRef.current.enqueue(async () => {
      const snapshot = await vaultApi.quickCommandDelete(commandId);
      if (mountedRef.current) applyConfigSnapshot(snapshot);
    }).catch((error) => {
      if (isAsyncQueueInvalidatedError(error)) return;
      throw error;
    });
  }

  function invalidateSettingsMutations() {
    quickCommandQueueRef.current.invalidate();
  }

  return {
    saveSettings,
    upsertQuickCommand,
    deleteQuickCommand,
    invalidateSettingsMutations,
  };
}
