import { joinPath as joinRemotePath, normalizePath as normalizeRemotePath } from "../lib/path";
import type { RemoteFileEntry } from "../types";

export type RemoteDownloadSelection = {
  remotePath: string;
  fileName: string;
  fileType: RemoteFileEntry["fileType"];
};

export type RemoteDownloadFile = {
  remotePath: string;
  relativePath: string;
};

export type RemoteDownloadPlan = {
  directories: string[];
  files: RemoteDownloadFile[];
};

type PendingDirectory = {
  remotePath: string;
  relativePath: string;
};

const DEFAULT_DIRECTORY_SCAN_CONCURRENCY = 6;

export async function buildRemoteDownloadPlan(
  selections: readonly RemoteDownloadSelection[],
  listDirectory: (path: string) => Promise<RemoteFileEntry[]>,
  concurrency = DEFAULT_DIRECTORY_SCAN_CONCURRENCY,
): Promise<RemoteDownloadPlan> {
  const directories: string[] = [];
  const files: RemoteDownloadFile[] = [];
  const pendingDirectories: PendingDirectory[] = [];
  const seenRemoteDirectories = new Set<string>();
  const seenLocalTargets = new Set<string>();

  for (const selection of selections) {
    const fileName = safePathSegment(selection.fileName, selection.remotePath);
    const remotePath = normalizeRemotePath(selection.remotePath);
    if (selection.fileType === "directory") {
      addDirectory(remotePath, fileName);
    } else {
      addFile(remotePath, fileName);
    }
  }

  const batchSize = Math.max(1, Math.min(12, Math.floor(concurrency) || 1));
  while (pendingDirectories.length > 0) {
    const batch = pendingDirectories.splice(0, batchSize);
    const listings = await Promise.all(batch.map(async (directory) => {
      try {
        return await listDirectory(directory.remotePath);
      } catch (error) {
        throw new Error(`读取远端目录 ${directory.remotePath} 失败：${downloadPlanErrorMessage(error)}`);
      }
    }));

    for (let index = 0; index < batch.length; index += 1) {
      const directory = batch[index];
      for (const entry of listings[index]) {
        const name = safePathSegment(entry.name, directory.remotePath);
        const remotePath = joinRemotePath(directory.remotePath, name);
        const relativePath = `${directory.relativePath}/${name}`;
        if (entry.fileType === "directory") {
          addDirectory(remotePath, relativePath);
        } else {
          addFile(remotePath, relativePath);
        }
      }
    }
  }

  return { directories, files };

  function addDirectory(remotePath: string, relativePath: string) {
    const normalizedRemotePath = normalizeRemotePath(remotePath);
    if (seenRemoteDirectories.has(normalizedRemotePath)) return;
    ensureUniqueLocalTarget(relativePath, "目录");
    seenRemoteDirectories.add(normalizedRemotePath);
    directories.push(relativePath);
    pendingDirectories.push({ remotePath: normalizedRemotePath, relativePath });
  }

  function addFile(remotePath: string, relativePath: string) {
    ensureUniqueLocalTarget(relativePath, "文件");
    files.push({ remotePath: normalizeRemotePath(remotePath), relativePath });
  }

  function ensureUniqueLocalTarget(relativePath: string, kind: string) {
    const localTargetKey = relativePath.normalize("NFC").toUpperCase();
    if (seenLocalTargets.has(localTargetKey)) {
      throw new Error(`远端内容存在重复${kind}名，无法安全下载：${relativePath}`);
    }
    seenLocalTargets.add(localTargetKey);
  }
}

export function joinLocalDownloadPath(baseDirectory: string, relativePath: string) {
  const normalizedBase = baseDirectory.replace(/[\\/]+$/g, "");
  const normalizedRelative = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${normalizedBase || baseDirectory}/${normalizedRelative}`;
}

function safePathSegment(name: string, parentPath: string) {
  if (!name || !name.trim() || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`远端目录 ${parentPath} 包含不安全的名称：${name || "（空名称）"}`);
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || isWindowsReservedName(name)) {
    throw new Error(`远端名称无法安全保存到 Windows：${name}`);
  }
  return name;
}

function isWindowsReservedName(name: string) {
  const baseName = name.split(".", 1)[0].toUpperCase();
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(baseName);
}

function downloadPlanErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "未知错误";
}
