import { Modal } from "antd";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { appApi } from "../api/appApi";
import { vaultApi } from "../api/vaultApi";
import { getErrorMessage } from "../lib/configMapping";
import { useMountedRef } from "../lib/reactLifecycle";
import { normalizeUpdateVersion, updateAssetKey } from "../lib/updateAssets";
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
  const updateCheckVersionRef = useRef(0);
  const manualCheckVersionRef = useRef(0);
  const manualCheckInFlightRef = useRef(false);
  const downloadVersionRef = useRef(0);
  const currentUpdateVersionRef = useRef<string | null>(null);
  const currentAssetKeyRef = useRef<string | null>(null);
  const downloadedAssetKeyRef = useRef<string | null>(null);
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
    // 延迟自动检查不得取代正在进行的手动检查，否则旧的手动请求无法清掉 loading。
    if (!manual && manualCheckInFlightRef.current) return;
    const requestVersion = ++updateCheckVersionRef.current;
    if (manual) {
      manualCheckVersionRef.current = requestVersion;
      manualCheckInFlightRef.current = true;
      setUpdateChecking(true);
      setUpdateError(null);
    }
    try {
      const info = knownInfo ?? (await appApi.info());
      if (!mountedRef.current || requestVersion !== updateCheckVersionRef.current) return;
      setAppInfo(info);
      const next = await appApi.checkUpdate(info.version, info.arch);
      if (!mountedRef.current || requestVersion !== updateCheckVersionRef.current) return;
      if (!next) {
        setUpdateInfo(next);
        applyCurrentUpdateAsset(null, null);
        return;
      }
      const ignored = configSnapshotRef.current?.data.settings?.ignoredUpdateVersions ?? [];
      const candidate = normalizeUpdateVersion(next.latestVersion, next.tagName);
      const normalized = next.hasUpdate && candidate && ignored.includes(candidate) ? { ...next, hasUpdate: false } : next;
      setUpdateInfo(normalized);
      const nextAssetKey = updateAssetKey(normalized);
      applyCurrentUpdateAsset(candidate || null, nextAssetKey);
    } catch (error) {
      const message = getErrorMessage(error);
      if (!mountedRef.current || requestVersion !== updateCheckVersionRef.current) return;
      if (manual) {
        setUpdateError(message);
        Modal.error({ title: "检查更新失败", content: message });
      } else {
        console.warn("[helm] auto update check failed:", message);
      }
    } finally {
      if (manual && requestVersion === manualCheckVersionRef.current) {
        manualCheckInFlightRef.current = false;
        if (mountedRef.current) setUpdateChecking(false);
      }
    }
  }

  async function downloadUpdate(target = updateInfo) {
    const assetKey = updateAssetKey(target);
    if (!target?.asset || !assetKey || assetKey !== currentAssetKeyRef.current) return;
    const requestVersion = ++downloadVersionRef.current;
    setUpdateDownloading(true);
    try {
      const path = await appApi.downloadSignedUpdate(target.asset.downloadUrl, target.asset.name, target.asset.sha256);
      if (
        !mountedRef.current
        || requestVersion !== downloadVersionRef.current
        || currentAssetKeyRef.current !== assetKey
      ) return;
      downloadedAssetKeyRef.current = assetKey;
      setDownloadedUpdatePath(path);
    } catch (error) {
      if (
        mountedRef.current
        && requestVersion === downloadVersionRef.current
        && currentAssetKeyRef.current === assetKey
      ) {
        Modal.error({ title: "下载更新失败", content: getErrorMessage(error) });
      }
    } finally {
      if (mountedRef.current && requestVersion === downloadVersionRef.current) setUpdateDownloading(false);
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
    if (!target) return;
    const candidate = normalizeUpdateVersion(target.latestVersion, target.tagName);
    if (!candidate) return;
    const previous = configSnapshotRef.current?.data.settings?.ignoredUpdateVersions ?? [];
    if (previous.includes(candidate)) {
      markUpdateIgnored(candidate);
      return;
    }
    try {
      const next = await vaultApi.settingsIgnoreUpdateVersion(candidate);
      if (!mountedRef.current) return;
      applyConfigSnapshot(next);
      markUpdateIgnored(candidate);
    } catch (error) {
      if (mountedRef.current) {
        Modal.error({ title: "忽略版本失败", content: getErrorMessage(error) });
      }
    }
  }

  function applyCurrentUpdateAsset(version: string | null, assetKey: string | null) {
    const assetChanged = currentAssetKeyRef.current !== assetKey;
    currentUpdateVersionRef.current = version;
    currentAssetKeyRef.current = assetKey;
    if (assetChanged) {
      downloadVersionRef.current += 1;
      setUpdateDownloading(false);
    }
    if (!assetKey || downloadedAssetKeyRef.current !== assetKey) {
      downloadedAssetKeyRef.current = null;
      setDownloadedUpdatePath(null);
    }
  }

  function markUpdateIgnored(candidate: string) {
    if (currentUpdateVersionRef.current === candidate) {
      applyCurrentUpdateAsset(candidate, null);
    }
    setUpdateInfo((current) => (
      current && normalizeUpdateVersion(current.latestVersion, current.tagName) === candidate
        ? { ...current, hasUpdate: false }
        : current
    ));
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
