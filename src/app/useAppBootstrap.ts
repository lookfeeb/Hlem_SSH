import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appApi } from "../api/appApi";
import { isTauriRuntime } from "../api/runtime";
import { vaultApi } from "../api/vaultApi";
import { getErrorMessage } from "../lib/configMapping";
import { useAnimationFrameRegistry, useMountedRef } from "../lib/reactLifecycle";
import type { AppInfo, ConfigSnapshot } from "../types";

type UseAppBootstrapOptions = {
  applySnapshot: (snapshot: ConfigSnapshot, preferredSessionId?: string, preserveRuntime?: boolean) => void;
  initializeApiServerRuntime: () => Promise<void>;
};

export function useAppBootstrap({ applySnapshot, initializeApiServerRuntime }: UseAppBootstrapOptions) {
  const [appReady, setAppReady] = useState(false);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState<string>();
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const mountedRef = useMountedRef();
  const requestSafeAnimationFrame = useAnimationFrameRegistry();

  useEffect(() => {
    void initializeApp();
  }, []);

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
      console.error("[helm] Failed to load config snapshot:", error);
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
    } catch {
      // 版本信息失败不影响主流程。
    }
    if (mountedRef.current) await initializeApiServerRuntime();
  }

  function signalFrontendReady() {
    if (!isTauriRuntime()) return;
    requestSafeAnimationFrame(() => {
      requestSafeAnimationFrame(() => {
        if (!mountedRef.current) return;
        void invoke("frontend_ready").catch(() => undefined);
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
