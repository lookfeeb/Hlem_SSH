import { useState, type MutableRefObject } from "react";
import { appApi } from "../api/appApi";
import { getErrorMessage } from "../lib/configMapping";
import { useMountedRef } from "../lib/reactLifecycle";
import type { ConfigSnapshot } from "../types";

export function useApiServerRuntime(configSnapshotRef: MutableRefObject<ConfigSnapshot | undefined>) {
  const [apiServerRunning, setApiServerRunning] = useState(false);
  const mountedRef = useMountedRef();

  async function initializeApiServerRuntime() {
    try {
      const status = await appApi.apiServerStatus();
      if (!mountedRef.current) return;
      setApiServerRunning(status.running);
      if (status.running) return;

      const settings = configSnapshotRef.current?.data.settings;
      const sessionIds = settings ? apiSessionIdsFromSettings(settings) : [];
      if (!settings?.aiApiAutoStart || sessionIds.length === 0 || !settings.aiApiPort) return;

      try {
        const info = await appApi.apiServerStart(settings.aiApiPort, sessionIds);
        if (!mountedRef.current) return;
        setApiServerRunning(info.running);
      } catch (error) {
        if (mountedRef.current) {
          console.warn("[helm] failed to auto start api server:", getErrorMessage(error));
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        console.warn("[helm] failed to query api server status:", getErrorMessage(error));
      }
    }
  }

  return {
    apiServerRunning,
    setApiServerRunning,
    initializeApiServerRuntime,
  };
}

function apiSessionIdsFromSettings(settings: NonNullable<ConfigSnapshot["data"]["settings"]>) {
  return [...(settings.aiApiSessionIds ?? []), settings.aiApiSessionId ?? ""]
    .filter((id): id is string => Boolean(id))
    .slice(0, 20);
}
