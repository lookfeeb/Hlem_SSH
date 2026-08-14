import { sortRemoteEntries } from "../../lib/fileClassify";
import { getPathSegments, joinPath, normalizePath } from "../../lib/path";
import type { RemoteFileEntry, RemoteSession } from "../../types";

export type DirectoryViewState = {
  sftpId: string | null;
  currentPath: string;
  entries: Record<string, RemoteFileEntry[]>;
  expandedKeys: string[];
};

export type DirectorySessionIdentity = {
  sessionId: string;
  sftpId: string | null;
};

type DirectorySessionState = Pick<RemoteSession, "id" | "sftpId" | "currentPath" | "filesPath" | "files">;

const directoryViewStateCache = new Map<string, DirectoryViewState>();

export function saveDirectoryViewState(
  sessionId: string,
  sftpId: string | null,
  currentPath: string,
  entries: Record<string, RemoteFileEntry[]>,
  expandedKeys: string[],
) {
  directoryViewStateCache.set(sessionId, {
    sftpId,
    currentPath: normalizePath(currentPath),
    entries,
    expandedKeys,
  });
}

export function loadDirectoryViewState(session: DirectorySessionState): DirectoryViewState {
  const sftpId = session.sftpId ?? null;
  const path = normalizePath(session.currentPath);
  const cached = directoryViewStateCache.get(session.id);
  const entries = cached?.sftpId === sftpId ? { ...cached.entries } : {};
  if (sftpId && session.filesPath && normalizePath(session.filesPath) === path) {
    entries[path] = sortRemoteEntries(session.files);
  }
  const expandedKeys = cached?.sftpId === sftpId
    ? expandDirectoryParentsForPathChange([...cached.expandedKeys], cached.currentPath, path)
    : sftpId
      ? getDirectoryParentPaths(path)
      : ["/"];
  return { sftpId, currentPath: path, entries, expandedKeys };
}

export function clearDirectoryViewStateCache() {
  directoryViewStateCache.clear();
}

export function sameDirectorySession(left: DirectorySessionIdentity, right: DirectorySessionIdentity) {
  return left.sessionId === right.sessionId && left.sftpId === right.sftpId;
}

export function expandDirectoryParentsForPathChange(
  expandedKeys: string[],
  previousPath: string,
  nextPath: string,
) {
  if (normalizePath(previousPath) === normalizePath(nextPath)) return expandedKeys;
  const next = uniqueKeys([...expandedKeys, ...getDirectoryParentPaths(nextPath)]);
  return sameKeys(expandedKeys, next) ? expandedKeys : next;
}

export function getDirectoryParentPaths(path: string) {
  const segments = getPathSegments(path);
  const paths = ["/"];
  let current = "/";
  for (const segment of segments.slice(0, -1)) {
    current = joinPath(current, segment);
    paths.push(current);
  }
  return paths;
}

export function uniqueKeys(keys: string[]) {
  return Array.from(new Set(keys));
}

function sameKeys(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
