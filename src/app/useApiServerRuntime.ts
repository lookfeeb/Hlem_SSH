import { useState, type MutableRefObject } from "react";
import { appApi } from "../api/appApi";
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
      const sessionIds = settings
        ? [...(settings.aiApiSessionIds ?? []), settings.aiApiSessionId ?? ""].filter(Boolean).slice(0, 5)
        : [];
      if (!settings?.aiApiAutoStart || sessionIds.length === 0 || !settings.aiApiPort) return;

      try {
        const info = await appApi.apiServerStart(settings.aiApiPort, sessionIds);
        if (!mountedRef.current) return;
        setApiServerRunning(info.running);
      } catch {
        // 自动启动失败不影响主流程。
      }
    } catch {
      // API 状态查询失败不影响主流程。
    }
  }

  return {
    apiServerRunning,
    setApiServerRunning,
    initializeApiServerRuntime,
  };
}
