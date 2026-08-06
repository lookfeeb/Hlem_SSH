import { Modal } from "antd";
import { useRef, type MutableRefObject } from "react";
import { appApi } from "../api/appApi";
import { remoteApi } from "../api/remoteApi";
import type { FileOperation } from "../components/FileManager";
import { defaultRemoteHomePath, getErrorMessage } from "../lib/configMapping";
import { getParentPath as getRemoteParentPath, joinPath as joinRemotePath, normalizePath as normalizeRemotePath } from "../lib/path";
import { useMountedRef } from "../lib/reactLifecycle";
import {
  remoteSessionPath,
  notifyEditorSessionReconnected,
  runUploadQueue,
  sftpUnavailableMessage,
  uploadConcurrency,
} from "./appHelpers";
import {
  buildRemoteDownloadPlan,
  joinLocalDownloadPath,
  type RemoteDownloadSelection,
} from "./remoteDownloadPlan";
import { resolveSftpSessionTarget } from "./sftpSessionState";
import type { RemoteSession, TransferInfo } from "../types";

type OpenSftpResult = {
  sftp: { sftpId: string } | null;
  path: string;
  files: RemoteSession["files"];
  error: unknown;
};

type RefreshFilesResult = "applied" | "failed" | "stale";

type UseSftpFilesOptions = {
  activeSession: RemoteSession | undefined;
  sessionsRef: MutableRefObject<RemoteSession[]>;
  updateSession: (sessionId: string, updater: (session: RemoteSession) => RemoteSession) => void;
  setSessionFilesLoading: (sessionId: string, loading: boolean) => void;
  listFiles: (sftpId: string, path: string) => Promise<RemoteSession["files"]>;
  appendTerminal: (sessionId: string, kind: "system" | "error", content: string) => void;
  formatSessionError: (error: unknown, session: Pick<RemoteSession, "name" | "connectionId" | "terminalId" | "sftpId">) => string;
  upsertTransfer: (transfer: TransferInfo) => void;
  openTransferCenter: () => void;
};

function remoteRelativePath(relativePath: string) {
  return relativePath.replace(/\\/g, "/");
}

export function useSftpFiles({
  activeSession,
  sessionsRef,
  updateSession,
  setSessionFilesLoading,
  listFiles,
  appendTerminal,
  formatSessionError,
  upsertTransfer,
  openTransferCenter,
}: UseSftpFilesOptions) {
  const lastDownloadDirRef = useRef("");
  const refreshRequestSeqRef = useRef<Map<string, number>>(new Map());
  const sftpConnectRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const mountedRef = useMountedRef();

  async function openSftpWithFiles(connectionId: string, initialPath: string, username: string, loginPath?: string | null): Promise<OpenSftpResult> {
    let sftp: { sftpId: string } | null = null;
    try {
      sftp = await remoteApi.openSftp(connectionId);
      try {
        const files = await listFiles(sftp.sftpId, initialPath);
        return { sftp, path: initialPath, files, error: null };
      } catch (error) {
        const homePath = loginPath ? normalizeRemotePath(loginPath) : defaultRemoteHomePath(username);
        if (normalizeRemotePath(initialPath) === homePath) throw error;
        const files = await listFiles(sftp.sftpId, homePath);
        return { sftp, path: homePath, files, error: null };
      }
    } catch (error) {
      // Opening the SFTP channel and listing the initial directory are separate
      // concerns. Keep an opened channel even when the initial path cannot be
      // listed, otherwise a later retry needlessly tears down and recreates it.
      return { sftp, path: initialPath, files: [], error };
    }
  }

  async function ensureSessionSftp(sessionId: string, connectionId?: string) {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    if (
      !session ||
      session.state !== "connected" ||
      !session.connectionId ||
      (connectionId && session.connectionId !== connectionId) ||
      session.sftpId
    ) return;

    const expectedConnectionId = session.connectionId;
    const requestKey = `${sessionId}:${expectedConnectionId}`;
    const existing = sftpConnectRequestsRef.current.get(requestKey);
    if (existing) return existing;

    let request: Promise<void>;
    request = (async () => {
      setSessionFilesLoading(sessionId, true);
      try {
        const current = sessionsRef.current.find((item) => item.id === sessionId);
        if (
          !current ||
          current.state !== "connected" ||
          current.connectionId !== expectedConnectionId ||
          current.sftpId
        ) return;

        const sftpResult = await openSftpWithFiles(
          expectedConnectionId,
          remoteSessionPath(current),
          current.username,
          current.loginPath,
        );
        if (!sftpResult.sftp) {
          throw new Error(`SFTP 不可用：${sftpUnavailableMessage(sftpResult.error)}`);
        }

        const sftp = sftpResult.sftp;
        const latest = sessionsRef.current.find((item) => item.id === sessionId);
        if (
          !mountedRef.current ||
          !latest ||
          latest.state !== "connected" ||
          latest.connectionId !== expectedConnectionId ||
          latest.sftpId
        ) {
          // `sftp_open` is idempotent per SSH connection. The returned id may
          // already be in use by another concurrent caller, so it must not be
          // closed merely because this request became stale. SSH disconnect
          // cleanup owns the channel lifetime.
          return;
        }

        sessionsRef.current = sessionsRef.current.map((item) =>
          item.id === sessionId && item.connectionId === expectedConnectionId && !item.sftpId
            ? { ...item, currentPath: sftpResult.path, sftpId: sftp.sftpId, files: sftpResult.files }
            : item,
        );
        updateSession(sessionId, (item) =>
          item.connectionId === expectedConnectionId && !item.sftpId
            ? {
                ...item,
                currentPath: sftpResult.path,
                sftpId: sftp.sftpId,
                files: sftpResult.files,
              }
            : item,
        );
        if (sftpResult.error) {
          console.warn("[helm] sftp connected but initial directory could not be listed:", getErrorMessage(sftpResult.error));
        }
        notifyEditorSessionReconnected(sessionId);
      } finally {
        if (mountedRef.current) setSessionFilesLoading(sessionId, false);
      }
    })().finally(() => {
      if (sftpConnectRequestsRef.current.get(requestKey) === request) {
        sftpConnectRequestsRef.current.delete(requestKey);
      }
    });
    sftpConnectRequestsRef.current.set(requestKey, request);
    return request;
  }

  async function changePath(sessionId: string, path: string) {
    const session = resolveSession(sessionId);
    if (!session) return;
    const previousPath = normalizeRemotePath(session.currentPath);
    const nextPath = normalizeRemotePath(path);
    sessionsRef.current = sessionsRef.current.map((item) =>
      item.id === session.id ? { ...item, currentPath: nextPath } : item,
    );
    updateSession(session.id, (item) => ({ ...item, currentPath: nextPath }));
    if (!session.sftpId) return;
    setSessionFilesLoading(session.id, true);
    try {
      const result = await refreshFiles(session.sftpId, nextPath, session.id);
      if (result === "failed" && mountedRef.current) {
        updateSession(session.id, (item) =>
          item.sftpId === session.sftpId && normalizeRemotePath(item.currentPath) === nextPath
            ? { ...item, currentPath: previousPath }
            : item,
        );
      }
    } finally {
      if (mountedRef.current) setSessionFilesLoading(session.id, false);
    }
  }

  async function refreshSessionFiles(sessionId: string) {
    const session = resolveSession(sessionId);
    if (!session) return;
    if (!session.sftpId) {
      await ensureSessionSftp(session.id, session.connectionId ?? undefined);
      return;
    }
    setSessionFilesLoading(session.id, true);
    try {
      await refreshFiles(session.sftpId, session.currentPath, session.id);
    } finally {
      if (mountedRef.current) setSessionFilesLoading(session.id, false);
    }
  }

  async function runFileOperation(sessionId: string, operation: FileOperation) {
    const session = resolveSession(sessionId);
    if (!session?.sftpId) throw new Error("当前连接不可用");
    const sftpId = session.sftpId;
    switch (operation.kind) {
      case "create":
        if (operation.entryType === "directory") {
          await remoteApi.mkdir(sftpId, operation.path);
        } else {
          await remoteApi.createFile(sftpId, operation.path);
        }
        break;
      case "rename":
        await remoteApi.rename(sftpId, operation.sourcePath, operation.targetPath);
        break;
      case "copy":
        await remoteApi.copy(
          sftpId,
          operation.sourcePath,
          await remoteApi.resolveTarget(sftpId, remoteSessionPath(session), operation.sourcePath, operation.targetPath),
        );
        break;
      case "move":
        await remoteApi.rename(
          sftpId,
          operation.sourcePath,
          await remoteApi.resolveTarget(sftpId, remoteSessionPath(session), operation.sourcePath, operation.targetPath),
        );
        break;
      case "delete":
        if (normalizeRemotePath(operation.sourcePath) === "/") throw new Error("不能删除根目录");
        await remoteApi.delete(sftpId, operation.sourcePath, true);
        break;
      case "deleteMany":
        for (const sourcePath of operation.sourcePaths) {
          if (normalizeRemotePath(sourcePath) === "/") throw new Error("不能删除根目录");
        }
        for (const sourcePath of operation.sourcePaths) {
          await remoteApi.delete(sftpId, sourcePath, true);
        }
        break;
    }
  }

  async function uploadLocalFiles(sessionId: string, localPaths: string[], targetDirectory: string) {
    const session = resolveSession(sessionId);
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    const sftpId = session.sftpId;
    const expanded = await appApi.expandLocalPaths(localPaths);
    if (expanded.length === 0) return;
    if (!isSessionSftpCurrent(session.id, sftpId)) throw new Error("当前 SFTP 会话已变化，请重试");
    const remoteTargets = expanded.map((entry) => joinRemotePath(targetDirectory, remoteRelativePath(entry.relativePath)));
    const existingRemoteTargets = (await Promise.all(remoteTargets.map(async (path) => (await remoteApi.pathExists(sftpId, path)) ? path : null))).filter((path): path is string => Boolean(path));
    if (existingRemoteTargets.length > 0 && !(await confirmOverwrite(`将覆盖 ${existingRemoteTargets.length} 个远端文件，是否继续？`))) return;
    const queueConcurrency = expanded.length === 1 ? 1 : uploadConcurrency(expanded.length);
    const dirsToCreate = new Set<string>();
    for (const entry of expanded) {
      const parts = remoteRelativePath(entry.relativePath).split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        dirsToCreate.add(joinRemotePath(targetDirectory, parts.slice(0, depth).join("/")));
      }
    }
    const sortedDirs = [...dirsToCreate].sort((a, b) => a.length - b.length);
    for (const dir of sortedDirs) {
      try {
        await remoteApi.mkdir(sftpId, dir);
      } catch (error) {
        console.warn(`[helm] failed to ensure remote upload directory ${dir}:`, getErrorMessage(error));
      }
    }
    const queuedTransfers = await runUploadQueue(
      expanded,
      queueConcurrency,
      (entry) => {
        const remotePath = joinRemotePath(targetDirectory, remoteRelativePath(entry.relativePath));
        return remoteApi.upload(sftpId, entry.localPath, remotePath, true, true, false);
      },
    );
    if (!mountedRef.current) return;
    queuedTransfers.forEach(upsertTransfer);
    if (queuedTransfers.length > 1) openTransferCenter();
  }

  async function downloadRemoteFiles(sessionId: string, files: RemoteDownloadSelection[]) {
    const session = resolveSession(sessionId);
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    const sftpId = session.sftpId;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({
      title: "选择下载目录",
      directory: true,
      defaultPath: lastDownloadDirRef.current || undefined,
    });
    if (typeof dir !== "string") return;
    if (!mountedRef.current) return;
    if (!isSessionSftpCurrent(sessionId, sftpId)) throw new Error("当前 SFTP 会话已变化，请重试");
    lastDownloadDirRef.current = dir;

    const plan = await buildRemoteDownloadPlan(files, async (remotePath) => {
      if (!isSessionSftpCurrent(sessionId, sftpId)) throw new Error("当前 SFTP 会话已变化，请重试");
      return listFiles(sftpId, remotePath);
    });
    if (!isSessionSftpCurrent(sessionId, sftpId)) throw new Error("当前 SFTP 会话已变化，请重试");

    const localTargets = plan.files.map((file) => joinLocalDownloadPath(dir, file.relativePath));
    const existingLocalTargets = (await runUploadQueue(
      localTargets,
      uploadConcurrency(localTargets.length),
      async (path) => (await appApi.localPathExists(path)) ? path : null,
    )).filter((path): path is string => Boolean(path));
    if (existingLocalTargets.length > 0 && !(await confirmOverwrite(`将覆盖 ${existingLocalTargets.length} 个本地文件，是否继续？`))) return;

    if (!isSessionSftpCurrent(sessionId, sftpId)) throw new Error("当前 SFTP 会话已变化，请重试");
    const localDirectories = plan.directories.map((relativePath) => joinLocalDownloadPath(dir, relativePath));
    if (localDirectories.length > 0) await appApi.createLocalDirectories(localDirectories);

    const failures: { relativePath: string; error: unknown }[] = [];
    let queuedCount = 0;
    await runUploadQueue(
      plan.files,
      uploadConcurrency(plan.files.length),
      async (file) => {
        try {
          if (!isSessionSftpCurrent(sessionId, sftpId)) throw new Error("当前 SFTP 会话已变化，请重试");
          const localPath = joinLocalDownloadPath(dir, file.relativePath);
          const transfer = await remoteApi.download(sftpId, file.remotePath, localPath, true);
          queuedCount += 1;
          if (mountedRef.current) upsertTransfer(transfer);
        } catch (error) {
          failures.push({ relativePath: file.relativePath, error });
        }
      },
    );
    if (queuedCount > 0) openTransferCenter();
    if (failures.length > 0) {
      const first = failures[0];
      throw new Error(
        `${failures.length} 个下载任务未能启动；${first.relativePath}：${getErrorMessage(first.error)}`,
      );
    }
  }

  function isSessionSftpCurrent(sessionId: string, sftpId: string) {
    const current = sessionsRef.current.find((item) => item.id === sessionId);
    return Boolean(current?.sftpId === sftpId);
  }

  function confirmOverwrite(content: string) {
    return new Promise<boolean>((resolve) => {
      Modal.confirm({ title: "确认覆盖", content, okText: "覆盖", cancelText: "取消", onOk: () => resolve(true), onCancel: () => resolve(false) });
    });
  }

  function resolveSession(sessionId?: string) {
    return resolveSftpSessionTarget(sessionsRef.current, sessionId, activeSession);
  }

  async function readRemoteText(path: string, sessionId?: string) {
    const session = resolveSession(sessionId);
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    return remoteApi.readText(session.sftpId, path);
  }

  async function writeRemoteTextRaw(path: string, content: string, sessionId?: string) {
    const session = resolveSession(sessionId);
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    await remoteApi.writeText(session.sftpId, path, content);
  }

  async function refreshFiles(sftpId: string, path: string, sessionId: string): Promise<RefreshFilesResult> {
    const normalizedPath = normalizeRemotePath(path);
    const requestSeq = (refreshRequestSeqRef.current.get(sessionId) ?? 0) + 1;
    refreshRequestSeqRef.current.set(sessionId, requestSeq);
    try {
      const files = await listFiles(sftpId, normalizedPath);
      if (!isCurrentFileRequest(sessionId, sftpId, normalizedPath, requestSeq)) return "stale";
      updateSession(sessionId, (session) =>
        session.sftpId === sftpId && normalizeRemotePath(session.currentPath) === normalizedPath
          ? { ...session, files }
          : session,
      );
      return "applied";
    } catch (error) {
      if (!isCurrentFileRequest(sessionId, sftpId, normalizedPath, requestSeq)) return "stale";
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      appendTerminal(sessionId, "error", session ? formatSessionError(error, session) : getErrorMessage(error));
      return "failed";
    }
  }

  async function refreshFilesForTransfer(transfer: TransferInfo) {
    const directory = getRemoteParentPath(transfer.remotePath);
    const targets = sessionsRef.current.filter(
      (session) => session.sftpId === transfer.sftpId && normalizeRemotePath(remoteSessionPath(session)) === directory,
    );
    await Promise.all(targets.map((session) => refreshFiles(transfer.sftpId, directory, session.id)));
  }

  function isCurrentFileRequest(sessionId: string, sftpId: string, path: string, requestSeq: number) {
    if (!mountedRef.current || refreshRequestSeqRef.current.get(sessionId) !== requestSeq) return false;
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    return Boolean(
      session &&
      session.sftpId === sftpId &&
      normalizeRemotePath(session.currentPath) === path,
    );
  }

  async function searchRemoteFile(sessionId: string, query: string) {
    const session = resolveSession(sessionId);
    if (!session?.sftpId) return null;
    const sftpId = session.sftpId;
    const targetPath = await remoteApi.searchFile(sftpId, remoteSessionPath(session), query);
    const currentSession = sessionsRef.current.find((item) => item.id === sessionId);
    if (!mountedRef.current || currentSession?.sftpId !== sftpId) return null;
    if (!targetPath) return null;
    const directory = getRemoteParentPath(targetPath);
    setSessionFilesLoading(sessionId, true);
    try {
      const files = await listFiles(sftpId, directory);
      const latestSession = sessionsRef.current.find((item) => item.id === sessionId);
      if (!mountedRef.current || latestSession?.sftpId !== sftpId) return null;
      updateSession(sessionId, (item) => ({
        ...item,
        currentPath: directory,
        files,
      }));
    } finally {
      if (mountedRef.current && sessionsRef.current.some((item) => item.id === sessionId)) {
        setSessionFilesLoading(sessionId, false);
      }
    }
    return targetPath;
  }

  async function listRemoteDirectory(sessionId: string, path: string) {
    const session = resolveSession(sessionId);
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    return listFiles(session.sftpId, path);
  }

  return {
    ensureSessionSftp,
    changePath,
    refreshSessionFiles,
    runFileOperation,
    uploadLocalFiles,
    downloadRemoteFiles,
    readRemoteText,
    writeRemoteTextRaw,
    refreshFiles,
    refreshFilesForTransfer,
    searchRemoteFile,
    listRemoteDirectory,
  };
}
