import { defaultBackupSettings, vaultApi } from "../api/vaultApi";
import { useMountedRef } from "../lib/reactLifecycle";
import type { AppSettings, ConfigSnapshot } from "../types";

type UseSettingsPersistenceOptions = {
  configSnapshot: ConfigSnapshot | undefined;
  applyConfigSnapshot: (snapshot: ConfigSnapshot) => void;
  onSettingsSaved: () => void;
};

export function useSettingsPersistence({
  configSnapshot,
  applyConfigSnapshot,
  onSettingsSaved,
}: UseSettingsPersistenceOptions) {
  const mountedRef = useMountedRef();

  async function saveSettings(settings: AppSettings) {
    const snapshot = await vaultApi.settingsUpdate(settings);
    if (!mountedRef.current) return;
    applyConfigSnapshot(snapshot);
    onSettingsSaved();
  }

  async function saveQuickCommands(nextCommands: AppSettings["quickCommands"]) {
    if (!configSnapshot) return;
    const snapshot = await vaultApi.settingsUpdate({
      ...configSnapshot.data.settings,
      backup: configSnapshot.data.settings.backup ?? defaultBackupSettings(),
      quickCommands: nextCommands ?? [],
    });
    if (!mountedRef.current) return;
    applyConfigSnapshot(snapshot);
  }

  return {
    saveSettings,
    saveQuickCommands,
  };
}
