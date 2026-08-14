import { useCallback, useRef, useState } from "react";
import { appApi } from "../api/appApi";
import { getErrorMessage } from "../lib/configMapping";
import { useMountedRef } from "../lib/reactLifecycle";

export function useApiServerRuntime() {
  const [apiServerRunning, setApiServerRunningState] = useState(false);
  const mountedRef = useMountedRef();
  const initializationVersionRef = useRef(0);

  const setApiServerRunning = useCallback((running: boolean) => {
    // 运行时事件或显式操作比初始化查询更新；使所有在途初始化结果失效。
    initializationVersionRef.current += 1;
    setApiServerRunningState(running);
  }, []);

  async function initializeApiServerRuntime() {
    const requestVersion = ++initializationVersionRef.current;
    try {
      const status = await appApi.apiServerStatus();
      if (!mountedRef.current || requestVersion !== initializationVersionRef.current) return;
      setApiServerRunningState(status.running);
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
