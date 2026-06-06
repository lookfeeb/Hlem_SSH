import { useRef, type MutableRefObject } from "react";
import { appApi } from "../api/appApi";
import { remoteApi } from "../api/remoteApi";
import type { FileOperation } from "../components/FileManager";
import { defaultRemoteHomePath, getErrorMessage, initialRemotePath } from "../lib/configMapping";
import { getParentPath as getRemoteParentPath, joinPath as joinRemotePath, normalizePath as normalizeRemotePath } from "../lib/path";
import { createTerminalEntry } from "../lib/session";
import {
  remoteSessionPath,
  resolveSftpOperationTarget,
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
  appendTerminal: (sessionId: string, kind: "system" | "error", content: string) => void;
  formatSessionError: (error: unknown, session: Pick<RemoteSession, "name" | "connectionId" | "terminalId" | "sftpId">) => string;
  upsertTransfer: (transfer: TransferInfo) => void;
  rememberTransferTarget: (sftpId: string, sessionId: string) => void;
  openTransferCenter: () => void;
};

export function useSftpFiles({
  activeSession,
  sessionsRef,
  updateSession,
  setSessionFilesLoading,
  appendTerminal,
  formatSessionError,
  upsertTransfer,
  rememberTransferTarget,
  openTransferCenter,
}: UseSftpFilesOptions) {
  const lastDownloadDirRef = useRef("");

  async function openSftpWithFiles(connectionId: string, initialPath: string, username: string): Promise<OpenSftpResult> {
    try {
      const sftp = await remoteApi.openSftp(connectionId);
      try {
        const files = await remoteApi.listFiles(sftp.sftpId, initialPath);
        return { sftp, path: initialPath, files, error: null };
      } catch (error) {
        const homePath = defaultRemoteHomePath(username);
        if (normalizeRemotePath(initialPath) === homePath) throw error;
        const files = await remoteApi.listFiles(sftp.sftpId, homePath);
        return { sftp, path: homePath, files, error: null };
      }
    } catch (error) {
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
      setSessionFilesLoading(session.id, false);
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

      appendTerminal(session.id, "system", "正在连接 SFTP...");
      const sftpResult = await openSftpWithFiles(
        session.connectionId,
        initialRemotePath(session.username, session.currentPath),
        session.username,
      );
      if (!sftpResult.sftp) {
        appendTerminal(session.id, "error", `SFTP 不可用：${sftpUnavailableMessage(sftpResult.error)}`);
        return;
      }
      const sftp = sftpResult.sftp;
      updateSession(session.id, (item) =>
        item.connectionId === session.connectionId
          ? {
              ...item,
              currentPath: sftpResult.path,
              sftpId: sftp.sftpId,
              files: sftpResult.files,
              terminal: [...item.terminal, createTerminalEntry("system", "SFTP 已连接")],
            }
          : item,
      );
    } finally {
      setSessionFilesLoading(session.id, false);
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
          await resolveSftpOperationTarget(sftpId, remoteSessionPath(session), operation.sourcePath, operation.targetPath),
        );
        break;
      case "move":
        await remoteApi.rename(
          sftpId,
          operation.sourcePath,
          await resolveSftpOperationTarget(sftpId, remoteSessionPath(session), operation.sourcePath, operation.targetPath),
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
    const expanded = await appApi.expandLocalPaths(localPaths);
    if (expanded.length === 0) return;
    const queueConcurrency = expanded.length === 1 ? 1 : uploadConcurrency(expanded.length);
    const dirsToCreate = new Set<string>();
    for (const entry of expanded) {
      const parts = entry.relativePath.replace(/\\/g, "/").split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        dirsToCreate.add(joinRemotePath(targetDirectory, parts.slice(0, depth).join("/")));
      }
    }
    const sortedDirs = [...dirsToCreate].sort((a, b) => a.length - b.length);
    for (const dir of sortedDirs) {
      try {
        await remoteApi.mkdir(session.sftpId, dir);
      } catch {
        // 目录可能已存在。
      }
    }
    const queuedTransfers = await runUploadQueue(
      expanded,
      queueConcurrency,
      (entry) => {
        const remotePath = joinRemotePath(targetDirectory, entry.relativePath.replace(/\\/g, "/"));
        return remoteApi.upload(session.sftpId!, entry.localPath, remotePath, true, true);
      },
    );
    queuedTransfers.filter(Boolean).forEach((transfer) => upsertTransfer(transfer as TransferInfo));
    if (queuedTransfers.filter(Boolean).length > 1) openTransferCenter();
  }

  async function downloadRemoteFile(remotePath: string, fileName: string) {
    const session = activeSession;
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    const { save } = await import("@tauri-apps/plugin-dialog");
    const localPath = await save({
      title: "下载文件",
      defaultPath: fileName,
    });
    if (!localPath) return;
    upsertTransfer(await remoteApi.download(session.sftpId, remotePath, localPath, true));
    openTransferCenter();
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
    if (!dir) return;
    lastDownloadDirRef.current = dir as string;
    for (const file of files) {
      const localPath = `${lastDownloadDirRef.current}/${file.fileName}`;
      upsertTransfer(await remoteApi.download(session.sftpId, file.remotePath, localPath, true));
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
    await refreshFiles(session.sftpId, remoteSessionPath(session), session.id);
  }

  async function refreshFiles(sftpId: string, path: string, sessionId: string) {
    try {
      const files = await remoteApi.listFiles(sftpId, path);
      updateSession(sessionId, (session) => ({ ...session, files }));
    } catch (error) {
      const session = sessionsRef.current.find((item) => item.id === sessionId || item.sftpId === sftpId);
      appendTerminal(sessionId, "error", session ? formatSessionError(error, session) : getErrorMessage(error));
    }
  }

  async function refreshFilesForTransfer(transfer: TransferInfo) {
    const directory = getRemoteParentPath(transfer.remotePath);
    try {
      const files = await remoteApi.listFiles(transfer.sftpId, directory);
      updateSessionBySftp(transfer.sftpId, (session) =>
        normalizeRemotePath(remoteSessionPath(session)) === directory ? { ...session, files } : session,
      );
    } catch {
      // 传输完成后的刷新失败不影响传输结果展示。
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
    if (!targetPath) return null;
    const directory = getRemoteParentPath(targetPath);
    setSessionFilesLoading(session.id, true);
    try {
      const files = await remoteApi.listFiles(session.sftpId, directory);
      updateSession(session.id, (item) => ({
        ...item,
        currentPath: directory,
        files,
      }));
    } finally {
      setSessionFilesLoading(session.id, false);
    }
    return targetPath;
  }

  async function listRemoteDirectory(path: string) {
    const session = activeSession;
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    return remoteApi.listFiles(session.sftpId, path);
  }

  return {
    openSftpWithFiles,
    changePath,
    refreshActiveFiles,
    runFileOperation,
    uploadLocalFiles,
    downloadRemoteFile,
    downloadRemoteFiles,
    readRemoteText,
    writeRemoteTextRaw,
    refreshFiles,
    refreshFilesForTransfer,
    searchRemoteFile,
    listRemoteDirectory,
  };
}
