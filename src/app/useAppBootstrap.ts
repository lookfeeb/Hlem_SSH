import { useEffect, useRef, useState } from "react";
import { appApi } from "../api/appApi";
import { call } from "../api/bridge";
import { isTauriRuntime } from "../api/runtime";
import { vaultApi } from "../api/vaultApi";
import { getErrorMessage } from "../lib/configMapping";
import { useAnimationFrameRegistry, useMountedRef } from "../lib/reactLifecycle";
import type { AppInfo, ConfigSnapshot } from "../types";

type UseAppBootstrapOptions = {
  enabled: boolean;
  applySnapshot: (snapshot: ConfigSnapshot, preferredSessionId?: string, preserveRuntime?: boolean) => void;
  onFrontendReady: () => Promise<void> | void;
};

export function useAppBootstrap({ enabled, applySnapshot, onFrontendReady }: UseAppBootstrapOptions) {
  const [appReady, setAppReady] = useState(false);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState<string>();
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const mountedRef = useMountedRef();
  const initializationStartedRef = useRef(false);
  const requestSafeAnimationFrame = useAnimationFrameRegistry();

  useEffect(() => {
    if (!enabled || initializationStartedRef.current) return;
    initializationStartedRef.current = true;
    void initializeApp();
  }, [enabled]);

  async function initializeApp() {
    try {
      setBootstrapError(undefined);
      const needsMigration = await vaultApi.needsMigration();
      if (needsMigration) {
        if (!mountedRef.current) return;
        setMigrationNeeded(true);
        return;
      }
      const snapshot = await vaultApi.snapshot();
      if (!mountedRef.current) return;
      applySnapshot(snapshot);
      setAppReady(true);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[helm] failed to load config snapshot:", message);
      if (mountedRef.current) setBootstrapError(message);
    } finally {
      signalFrontendReady();
      void initializeAppMetadata();
    }
  }

  async function handleMigrate(oldPassword: string) {
    await runMigration(() => vaultApi.migrate(oldPassword));
  }

  async function handleSkipMigration() {
    await runMigration(() => vaultApi.skipMigration());
  }

  async function runMigration(action: () => Promise<ConfigSnapshot>) {
    setMigrationBusy(true);
    setMigrationError(undefined);
    try {
      const snapshot = await action();
      if (!mountedRef.current) return;
      setMigrationNeeded(false);
      applySnapshot(snapshot);
      setAppReady(true);
      void initializeAppMetadata();
    } catch (error) {
      if (mountedRef.current) setMigrationError(getErrorMessage(error));
    } finally {
      if (mountedRef.current) setMigrationBusy(false);
    }
  }

  async function initializeAppMetadata() {
    try {
      const info = await appApi.info();
      if (mountedRef.current) setAppInfo(info);
    } catch (error) {
      console.warn("[helm] failed to load app info:", getErrorMessage(error));
    }
  }

  function signalFrontendReady() {
    if (!isTauriRuntime()) return;
    requestSafeAnimationFrame(() => {
      requestSafeAnimationFrame(() => {
        if (!mountedRef.current) return;
        void call<void>("frontend_ready")
          .then(() => onFrontendReady())
          .catch((error) => {
            console.warn("[helm] failed to finish frontend ready handshake:", getErrorMessage(error));
          });
      });
    });
  }

  return {
    appReady,
    migrationNeeded,
    migrationBusy,
    migrationError,
    bootstrapError,
    appInfo,
    setAppInfo,
    handleMigrate,
    handleSkipMigration,
  };
}
