import { useCallback, useRef, useState } from "react";
import { appApi, type ApiServerInfo } from "../api/appApi";
import { getErrorMessage } from "../lib/configMapping";
import { useMountedRef } from "../lib/reactLifecycle";

export function useApiServerRuntime() {
  const [apiServerStatus, setApiServerStatusState] = useState<ApiServerInfo>({ running: false, port: 0, apiKey: "" });
  const mountedRef = useMountedRef();
  const initializationVersionRef = useRef(0);

  const setApiServerStatus = useCallback((status: ApiServerInfo) => {
    // 运行时事件或显式操作比初始化查询更新；使所有在途初始化结果失效。
    initializationVersionRef.current += 1;
    setApiServerStatusState(status);
  }, []);

  async function initializeApiServerRuntime() {
    const requestVersion = ++initializationVersionRef.current;
    try {
      const status = await appApi.apiServerStatus();
      if (!mountedRef.current || requestVersion !== initializationVersionRef.current) return;
      setApiServerStatusState(status);
    } catch (error) {
      if (mountedRef.current) {
        console.warn("[helm] failed to query api server status:", getErrorMessage(error));
      }
    }
  }

  return {
    apiServerRunning: apiServerStatus.running,
    apiServerStarting: Boolean(apiServerStatus.starting),
    apiServerError: apiServerStatus.error ?? null,
    setApiServerStatus,
    initializeApiServerRuntime,
  };
}
