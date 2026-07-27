import { sortRemoteEntries } from "../../lib/fileClassify";
import { getParentPath, getPathSegments, joinPath, normalizePath } from "../../lib/path";
import type { RemoteFileEntry, RemoteSession } from "../../types";

export type DirectoryViewState = {
  sftpId: string | null;
  entries: Record<string, RemoteFileEntry[]>;
  expandedKeys: string[];
};

type DirectorySessionState = Pick<RemoteSession, "id" | "sftpId" | "currentPath" | "files">;

const directoryViewStateCache = new Map<string, DirectoryViewState>();

export function saveDirectoryViewState(
  sessionId: string,
  sftpId: string | null,
  entries: Record<string, RemoteFileEntry[]>,
  expandedKeys: string[],
) {
  directoryViewStateCache.set(sessionId, { sftpId, entries, expandedKeys });
}

export function loadDirectoryViewState(session: DirectorySessionState): DirectoryViewState {
  const sftpId = session.sftpId ?? null;
  const path = normalizePath(session.currentPath);
  const cached = directoryViewStateCache.get(session.id);
  const entries = cached?.sftpId === sftpId ? { ...cached.entries } : {};
  if (sftpId && filesBelongToDirectory(session.files, path)) {
    entries[path] = sortRemoteEntries(session.files);
  }
  const expandedKeys = cached?.sftpId === sftpId
    ? uniqueKeys([...cached.expandedKeys, ...getDirectoryAncestorPaths(path)])
    : sftpId
      ? getDirectoryAncestorPaths(path)
      : ["/"];
  return { sftpId, entries, expandedKeys };
}

export function clearDirectoryViewStateCache() {
  directoryViewStateCache.clear();
}

export function filesBelongToDirectory(files: RemoteFileEntry[], directoryPath: string) {
  const normalizedDirectory = normalizePath(directoryPath);
  return files.every((entry) => {
    if (!entry.path) return true;
    return getParentPath(entry.path) === normalizedDirectory;
  });
}

export function getDirectoryAncestorPaths(path: string) {
  const segments = getPathSegments(path);
  const paths = ["/"];
  let current = "/";
  for (const segment of segments) {
    current = joinPath(current, segment);
    paths.push(current);
  }
  return paths;
}

export function uniqueKeys(keys: string[]) {
  return Array.from(new Set(keys));
}
