import { useEffect, useState } from "react";
import { remoteApi } from "../api/remoteApi";
import { vaultApi } from "../api/vaultApi";
import { getErrorMessage } from "../lib/configMapping";
import { useMountedRef } from "../lib/reactLifecycle";
import type { ConfigSnapshot, ForwardInfo, ForwardStatusEvent, TunnelConfig, TunnelInput } from "../types";

type UseTunnelRuntimeOptions = {
  appReady: boolean;
  applyConfigSnapshot: (snapshot: ConfigSnapshot) => void;
};

export function useTunnelRuntime({ appReady, applyConfigSnapshot }: UseTunnelRuntimeOptions) {
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const mountedRef = useMountedRef();

  useEffect(() => {
    if (!appReady) return;
    let disposed = false;
    void remoteApi.listForwards().then((items) => {
      if (!disposed) setForwards(items);
    }).catch((error) => {
      if (!disposed) console.warn("[helm] failed to list forwards:", getErrorMessage(error));
    });
    return () => {
      disposed = true;
    };
  }, [appReady]);

  function upsertForward(payload: ForwardStatusEvent) {
    setForwards((current) => {
      if (payload.status === "canceled" || payload.status === "completed") {
        return current.filter((forward) => forward.forwardId !== payload.forwardId);
      }
      const existing = current.findIndex((forward) => forward.forwardId === payload.forwardId);
      if (existing === -1) return [payload, ...current];
      const next = [...current];
      next[existing] = payload;
      return next;
    });
  }

  function resetForwards() {
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
    const started =
      tunnel.forwardType === "local"
        ? await remoteApi.startLocalForward(tunnel.sessionId, tunnel.bindHost, tunnel.bindPort, tunnel.targetHost, tunnel.targetPort)
        : tunnel.forwardType === "remote"
          ? await remoteApi.startRemoteForward(tunnel.sessionId, tunnel.bindHost, tunnel.bindPort, tunnel.targetHost, tunnel.targetPort)
          : await remoteApi.startDynamicForward(tunnel.sessionId, tunnel.bindHost, tunnel.bindPort);
    if (mountedRef.current) upsertForward(started);
  }

  async function stopTunnel(forwardId: string) {
    await remoteApi.stopForward(forwardId);
    if (mountedRef.current) {
      setForwards((current) => current.filter((forward) => forward.forwardId !== forwardId));
    }
  }

  return {
    forwards,
    upsertForward,
    resetForwards,
    createTunnel,
    updateTunnel,
    deleteTunnel,
    startTunnel,
    stopTunnel,
  };
}
