import { useRef, type MutableRefObject } from "react";
import { appApi } from "../api/appApi";
import { remoteApi } from "../api/remoteApi";
import type { FileOperation } from "../components/FileManager";
import { defaultRemoteHomePath, getErrorMessage } from "../lib/configMapping";
import { getParentPath as getRemoteParentPath, joinPath as joinRemotePath, normalizePath as normalizeRemotePath } from "../lib/path";
import { useMountedRef } from "../lib/reactLifecycle";
import {
  remoteSessionPath,
  runUploadQueue,
  sftpUnavailableMessage,
  uploadConcurrency,
} from "./appHelpers";
import type { RemoteSession, TransferInfo } from "../types";

type OpenSftpResult = {
  sftp: { sftpId: string } | null;
  path: string;
  files: RemoteSession["files"];
  error: unknown;
};

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
      if (sftp) {
        await remoteApi.closeSftp(sftp.sftpId).catch((closeError) => {
          console.warn("[helm] failed to close sftp after open failure:", getErrorMessage(closeError));
        });
      }
      return { sftp: null, path: initialPath, files: [], error };
    }
  }

  async function changePath(path: string) {
    const session = activeSession;
    if (!session) return;
    updateSession(session.id, (item) => ({ ...item, currentPath: path }));
    if (!session.sftpId) return;
    setSessionFilesLoading(session.id, true);
    try {
      await refreshFiles(session.sftpId, path, session.id);
    } finally {
      if (mountedRef.current) setSessionFilesLoading(session.id, false);
    }
  }

  async function refreshActiveFiles() {
    const session = activeSession;
    if (!session) return;
    setSessionFilesLoading(session.id, true);
    try {
      if (session.sftpId) {
        await refreshFiles(session.sftpId, session.currentPath, session.id);
        return;
      }
      if (session.state !== "connected" || !session.connectionId) return;

      const sftpResult = await openSftpWithFiles(
        session.connectionId,
        remoteSessionPath(session),
        session.username,
        session.loginPath,
      );
      if (!sftpResult.sftp) {
        throw new Error(`SFTP 不可用：${sftpUnavailableMessage(sftpResult.error)}`);
      }
      if (!mountedRef.current) return;
      const sftp = sftpResult.sftp;
      updateSession(session.id, (item) =>
        item.connectionId === session.connectionId
          ? {
              ...item,
              currentPath: sftpResult.path,
              sftpId: sftp.sftpId,
              files: sftpResult.files,
            }
          : item,
      );
    } finally {
      if (mountedRef.current) setSessionFilesLoading(session.id, false);
    }
  }

  async function runFileOperation(operation: FileOperation) {
    const session = activeSession;
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
    const latestSession = sessionsRef.current.find((item) => item.id === session.id);
    if (latestSession?.sftpId === sftpId) {
      await refreshFiles(sftpId, remoteSessionPath(latestSession), latestSession.id);
    }
  }

  async function uploadLocalFiles(localPaths: string[], targetDirectory: string) {
    const session = activeSession;
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    const sftpId = session.sftpId;
    const expanded = await appApi.expandLocalPaths(localPaths);
    if (expanded.length === 0) return;
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
        return remoteApi.upload(sftpId, entry.localPath, remotePath, true, true);
      },
    );
    if (!mountedRef.current) return;
    queuedTransfers.forEach(upsertTransfer);
    if (queuedTransfers.length > 1) openTransferCenter();
  }

  async function downloadRemoteFiles(files: { remotePath: string; fileName: string }[]) {
    const session = activeSession;
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({
      title: "选择下载目录",
      directory: true,
      defaultPath: lastDownloadDirRef.current || undefined,
    });
    if (typeof dir !== "string") return;
    if (!mountedRef.current) return;
    lastDownloadDirRef.current = dir;
    for (const file of files) {
      const localPath = `${lastDownloadDirRef.current}/${file.fileName}`;
      const transfer = await remoteApi.download(session.sftpId, file.remotePath, localPath, true);
      if (!mountedRef.current) return;
      upsertTransfer(transfer);
    }
    openTransferCenter();
  }

  function resolveSession(sessionId?: string) {
    if (sessionId) {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (session) return session;
    }
    return activeSession;
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
    if (!mountedRef.current) return;
    await refreshFiles(session.sftpId, remoteSessionPath(session), session.id);
  }

  async function refreshFiles(sftpId: string, path: string, sessionId: string) {
    try {
      const files = await listFiles(sftpId, path);
      if (!mountedRef.current) return;
      updateSession(sessionId, (session) => ({ ...session, files }));
    } catch (error) {
      if (!mountedRef.current) return;
      const session = sessionsRef.current.find((item) => item.id === sessionId || item.sftpId === sftpId);
      appendTerminal(sessionId, "error", session ? formatSessionError(error, session) : getErrorMessage(error));
    }
  }

  async function refreshFilesForTransfer(transfer: TransferInfo) {
    const directory = getRemoteParentPath(transfer.remotePath);
    try {
      const files = await listFiles(transfer.sftpId, directory);
      if (!mountedRef.current) return;
      updateSessionBySftp(transfer.sftpId, (session) =>
        normalizeRemotePath(remoteSessionPath(session)) === directory ? { ...session, files } : session,
      );
    } catch (error) {
      console.warn("[helm] failed to refresh files after transfer:", getErrorMessage(error));
    }
  }

  function updateSessionBySftp(sftpId: string, updater: (session: RemoteSession) => RemoteSession) {
    for (const session of sessionsRef.current) {
      if (session.sftpId === sftpId) updateSession(session.id, updater);
    }
  }

  async function searchRemoteFile(query: string) {
    const session = activeSession;
    if (!session?.sftpId) return null;
    const targetPath = await remoteApi.searchFile(session.sftpId, remoteSessionPath(session), query);
    if (!mountedRef.current) return null;
    if (!targetPath) return null;
    const directory = getRemoteParentPath(targetPath);
    setSessionFilesLoading(session.id, true);
    try {
      const files = await listFiles(session.sftpId, directory);
      if (!mountedRef.current) return null;
      updateSession(session.id, (item) => ({
        ...item,
        currentPath: directory,
        files,
      }));
    } finally {
      if (mountedRef.current) setSessionFilesLoading(session.id, false);
    }
    return targetPath;
  }

  async function listRemoteDirectory(path: string) {
    const session = activeSession;
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    return listFiles(session.sftpId, path);
  }

  return {
    changePath,
    refreshActiveFiles,
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
