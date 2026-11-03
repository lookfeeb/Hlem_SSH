import { useEffect, useRef, useState } from "react";
import { remoteApi } from "../api/remoteApi";
import { vaultApi } from "../api/vaultApi";
import { getErrorMessage } from "../lib/configMapping";
import { applyForwardStatus, normalizeForwardList } from "../lib/forwardState";
import { useMountedRef } from "../lib/reactLifecycle";
import { loadStableSnapshot } from "../lib/stableSnapshot";
import type { ConfigSnapshot, ForwardInfo, TunnelConfig, TunnelInput } from "../types";

type UseTunnelRuntimeOptions = {
  appReady: boolean;
  panelOpen: boolean;
  applyConfigSnapshot: (snapshot: ConfigSnapshot) => void;
};

export function useTunnelRuntime({ appReady, panelOpen, applyConfigSnapshot }: UseTunnelRuntimeOptions) {
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const mountedRef = useMountedRef();
  const eventVersionRef = useRef(0);
  const stateEpochRef = useRef(0);
  const syncRequestRef = useRef(0);

  useEffect(() => {
    if (!appReady) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void remoteApi.onForwardStatus((payload) => {
      if (disposed) return;
      eventVersionRef.current += 1;
      setForwards((current) => applyForwardStatus(current, payload));
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    }).catch((error) => {
      if (!disposed) console.warn("[helm] failed to subscribe forward status:", getErrorMessage(error));
    }).finally(() => {
      if (!disposed) void synchronizeForwards();
    });
    return () => {
      disposed = true;
      syncRequestRef.current += 1;
      unlisten?.();
    };
  }, [appReady]);

  useEffect(() => {
    if (!appReady || !panelOpen) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") void synchronizeForwards();
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [appReady, panelOpen]);

  async function synchronizeForwards() {
    const requestId = ++syncRequestRef.current;
    const epoch = stateEpochRef.current;
    try {
      const items = await loadStableSnapshot(
        remoteApi.listForwards,
        () => eventVersionRef.current,
        () => (
          mountedRef.current &&
          requestId === syncRequestRef.current &&
          epoch === stateEpochRef.current
        ),
      );
      if (items) {
        setForwards(normalizeForwardList(items));
      }
    } catch (error) {
      if (mountedRef.current && requestId === syncRequestRef.current) {
        console.warn("[helm] failed to list forwards:", getErrorMessage(error));
      }
    }
  }

  function resetForwards() {
    stateEpochRef.current += 1;
    eventVersionRef.current += 1;
    syncRequestRef.current += 1;
    setForwards([]);
  }

  async function createTunnel(input: TunnelInput) {
    const snapshot = await vaultApi.tunnelCreate(input);
    if (mountedRef.current) applyConfigSnapshot(snapshot);
  }

  async function updateTunnel(tunnelId: string, input: TunnelInput) {
    const snapshot = await vaultApi.tunnelUpdate(tunnelId, input);
    if (mountedRef.current) applyConfigSnapshot(snapshot);
  }

  async function deleteTunnel(tunnelId: string) {
    const snapshot = await vaultApi.tunnelDelete(tunnelId);
    if (mountedRef.current) applyConfigSnapshot(snapshot);
  }

  async function startTunnel(tunnel: TunnelConfig) {
    const epoch = stateEpochRef.current;
    const eventVersion = eventVersionRef.current;
    try {
      const forward = await (
        tunnel.forwardType === "local"
          ? remoteApi.startLocalForward(tunnel.sessionId, tunnel.bindHost, tunnel.bindPort, tunnel.targetHost, tunnel.targetPort, tunnel.id)
          : tunnel.forwardType === "remote"
            ? remoteApi.startRemoteForward(tunnel.sessionId, tunnel.bindHost, tunnel.bindPort, tunnel.targetHost, tunnel.targetPort, tunnel.id)
            : remoteApi.startDynamicForward(tunnel.sessionId, tunnel.bindHost, tunnel.bindPort, tunnel.id)
      );
      if (mountedRef.current && epoch === stateEpochRef.current && eventVersion === eventVersionRef.current) {
        eventVersionRef.current += 1;
        setForwards((current) => applyForwardStatus(current, forward));
      }
    } finally {
      if (mountedRef.current && epoch === stateEpochRef.current) await synchronizeForwards();
    }
  }

  async function stopTunnel(forwardId: string) {
    const epoch = stateEpochRef.current;
    try {
      await remoteApi.stopForward(forwardId);
    } finally {
      if (mountedRef.current && epoch === stateEpochRef.current) await synchronizeForwards();
    }
  }

  return {
    forwards,
    resetForwards,
    createTunnel,
    updateTunnel,
    deleteTunnel,
    startTunnel,
    stopTunnel,
  };
}
