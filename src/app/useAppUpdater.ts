import { Modal } from "antd";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { appApi } from "../api/appApi";
import { defaultBackupSettings, vaultApi } from "../api/vaultApi";
import { getErrorMessage } from "../lib/configMapping";
import { useMountedRef } from "../lib/reactLifecycle";
import type { AppInfo, ConfigSnapshot, UpdateInfo } from "../types";

type UseAppUpdaterOptions = {
  appReady: boolean;
  appInfo: AppInfo | null;
  setAppInfo: (info: AppInfo) => void;
  configSnapshotRef: MutableRefObject<ConfigSnapshot | undefined>;
  applyConfigSnapshot: (snapshot: ConfigSnapshot) => void;
};

export function useAppUpdater({
  appReady,
  appInfo,
  setAppInfo,
  configSnapshotRef,
  applyConfigSnapshot,
}: UseAppUpdaterOptions) {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState<string | null>(null);
  const autoUpdateTimerRef = useRef<number | null>(null);
  const autoUpdateIdleCancelRef = useRef<(() => void) | null>(null);
  const autoUpdateScheduledRef = useRef(false);
  const mountedRef = useMountedRef();

  useEffect(() => {
    return () => {
      if (autoUpdateTimerRef.current !== null) {
        window.clearTimeout(autoUpdateTimerRef.current);
      }
      autoUpdateIdleCancelRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (!appReady || !appInfo) return;
    scheduleAutoUpdateCheck(appInfo);
  }, [appInfo, appReady]);

  function scheduleAutoUpdateCheck(info: AppInfo) {
    if (autoUpdateScheduledRef.current || autoUpdateTimerRef.current !== null) return;
    autoUpdateScheduledRef.current = true;
    autoUpdateTimerRef.current = window.setTimeout(() => {
      autoUpdateTimerRef.current = null;
      autoUpdateIdleCancelRef.current = runWhenBrowserIdle(() => {
        autoUpdateIdleCancelRef.current = null;
        void checkForUpdate(false, info);
      });
    }, 8000);
  }

  async function checkForUpdate(manual = true, knownInfo = appInfo) {
    const info = knownInfo ?? (await appApi.info());
    if (!mountedRef.current) return;
    setAppInfo(info);
    if (manual) {
      setUpdateChecking(true);
      setUpdateError(null);
    }
    try {
      const next = await appApi.checkUpdate(info.version, info.arch);
      if (!mountedRef.current) return;
      if (!next) {
        setUpdateInfo(next);
        return;
      }
      const ignored = configSnapshotRef.current?.data.settings?.ignoredUpdateVersions ?? [];
      const candidate = normalizeIgnoredVersion(next.latestVersion, next.tagName);
      setUpdateInfo(next.hasUpdate && candidate && ignored.includes(candidate) ? { ...next, hasUpdate: false } : next);
    } catch (error) {
      const message = getErrorMessage(error);
      if (!mountedRef.current) return;
      if (manual) {
        setUpdateError(message);
        Modal.error({ title: "检查更新失败", content: message });
      } else {
        console.warn("[helm] auto update check failed:", message);
      }
    } finally {
      if (manual && mountedRef.current) setUpdateChecking(false);
    }
  }

  async function downloadUpdate(target = updateInfo) {
    if (!target?.asset) return;
    setUpdateDownloading(true);
    try {
      const path = await appApi.downloadSignedUpdate(target.asset.downloadUrl, target.asset.name, target.asset.sha256);
      if (!mountedRef.current) return;
      setDownloadedUpdatePath(path);
    } catch (error) {
      if (mountedRef.current) {
        Modal.error({ title: "下载更新失败", content: getErrorMessage(error) });
      }
    } finally {
      if (mountedRef.current) setUpdateDownloading(false);
    }
  }

  async function installUpdate() {
    if (!downloadedUpdatePath) return;
    try {
      await appApi.installUpdate(downloadedUpdatePath);
    } catch (error) {
      if (mountedRef.current) {
        Modal.error({ title: "启动安装程序失败", content: getErrorMessage(error) });
      }
    }
  }

  async function ignoreUpdateVersion(target = updateInfo) {
    const snapshot = configSnapshotRef.current;
    if (!target || !snapshot) return;
    const candidate = normalizeIgnoredVersion(target.latestVersion, target.tagName);
    if (!candidate) return;
    const previous = snapshot.data.settings?.ignoredUpdateVersions ?? [];
    if (previous.includes(candidate)) {
      setUpdateInfo({ ...target, hasUpdate: false });
      return;
    }
    try {
      const next = await vaultApi.settingsUpdate({
        ...snapshot.data.settings,
        backup: snapshot.data.settings.backup ?? defaultBackupSettings(),
        ignoredUpdateVersions: [...previous, candidate],
      });
      if (!mountedRef.current) return;
      applyConfigSnapshot(next);
      setUpdateInfo({ ...target, hasUpdate: false });
    } catch (error) {
      if (mountedRef.current) {
        Modal.error({ title: "忽略版本失败", content: getErrorMessage(error) });
      }
    }
  }

  return {
    updateInfo,
    updateError,
    updateChecking,
    updateDownloading,
    downloadedUpdatePath,
    checkForUpdate,
    downloadUpdate,
    installUpdate,
    ignoreUpdateVersion,
  };
}

function runWhenBrowserIdle(task: () => void): () => void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(task, { timeout: 15_000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const timer = window.setTimeout(task, 0);
  return () => window.clearTimeout(timer);
}

function normalizeIgnoredVersion(latestVersion: string | undefined, tagName: string | undefined) {
  const candidate = (latestVersion || tagName || "").trim();
  if (!candidate) return "";
  return candidate.replace(/^v/i, "");
}
