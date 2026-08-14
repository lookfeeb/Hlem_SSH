import assert from "node:assert/strict";
import test from "node:test";
import {
  clearDirectoryViewStateCache,
  expandDirectoryParentsForPathChange,
  loadDirectoryViewState,
  sameDirectorySession,
  saveDirectoryViewState,
} from "../src/components/fileManager/directoryViewState";
import type { RemoteFileEntry } from "../src/types";

function directory(path: string): RemoteFileEntry {
  const name = path.split("/").filter(Boolean).at(-1) ?? "/";
  return {
    key: path,
    name,
    path,
    fileType: "directory",
    size: 0,
    modifiedAt: "",
    permissions: "drwxr-xr-x",
    owner: "root",
  };
}

test("switching back to a terminal restores its directory tree without reloading root", () => {
  clearDirectoryViewStateCache();
  const rootEntries = [directory("/home")];
  const homeEntries = [directory("/home/app")];
  saveDirectoryViewState(
    "session-a",
    "sftp-a",
    "/home",
    { "/": rootEntries, "/home": homeEntries },
    ["/", "/home"],
  );

  const restored = loadDirectoryViewState({
    id: "session-a",
    sftpId: "sftp-a",
    currentPath: "/home",
    filesPath: "/home",
    files: homeEntries,
  });

  assert.deepEqual(restored.entries["/"], rootEntries);
  assert.deepEqual(restored.entries["/home"], homeEntries);
  assert.deepEqual(restored.expandedKeys, ["/", "/home"]);
});

test("a genuinely changed SFTP id discards the previous channel cache", () => {
  clearDirectoryViewStateCache();
  saveDirectoryViewState(
    "session-a",
    "sftp-old",
    "/stale",
    { "/": [directory("/stale")] },
    ["/", "/stale"],
  );

  const currentFiles = [directory("/home/current")];
  const restored = loadDirectoryViewState({
    id: "session-a",
    sftpId: "sftp-new",
    currentPath: "/home",
    filesPath: "/home",
    files: currentFiles,
  });

  assert.equal(restored.entries["/"], undefined);
  assert.deepEqual(restored.entries["/home"], currentFiles);
  assert.deepEqual(restored.expandedKeys, ["/"]);
});

test("an empty file list is only cached for the directory it was loaded from", () => {
  clearDirectoryViewStateCache();
  const restored = loadDirectoryViewState({
    id: "session-a",
    sftpId: "sftp-a",
    currentPath: "/new",
    filesPath: "/old",
    files: [],
  });

  assert.equal(restored.entries["/new"], undefined);
  assert.deepEqual(restored.expandedKeys, ["/"]);
});

test("a new directory view reveals the selected path parents without expanding the selected directory", () => {
  clearDirectoryViewStateCache();
  const app = loadDirectoryViewState({
    id: "session-a",
    sftpId: "sftp-a",
    currentPath: "/root/app",
    filesPath: null,
    files: [],
  });

  assert.deepEqual(app.expandedKeys, ["/", "/root"]);
});

test("restoring a directory view preserves a manually collapsed selected-path parent", () => {
  clearDirectoryViewStateCache();
  saveDirectoryViewState(
    "session-a",
    "sftp-a",
    "/root/app",
    { "/": [directory("/root")], "/root": [directory("/root/app")] },
    ["/"],
  );

  const app = loadDirectoryViewState({
    id: "session-a",
    sftpId: "sftp-a",
    currentPath: "/root/app",
    filesPath: null,
    files: [],
  });
  assert.deepEqual(app.expandedKeys, ["/"]);
});

test("restoring a cached view reveals parents when its current path really changed", () => {
  clearDirectoryViewStateCache();
  saveDirectoryViewState(
    "session-a",
    "sftp-a",
    "/sys/block",
    { "/": [directory("/sys"), directory("/usr")] },
    ["/"],
  );

  const restored = loadDirectoryViewState({
    id: "session-a",
    sftpId: "sftp-a",
    currentPath: "/usr/bin",
    filesPath: null,
    files: [],
  });

  assert.deepEqual(restored.expandedKeys, ["/", "/usr"]);
});

test("expanding a directory keeps loads valid for the current SFTP session", () => {
  const renderedView = {
    sessionId: "session-a",
    sftpId: "sftp-a",
    expandedKeys: ["/"],
  };
  const expandedView = {
    ...renderedView,
    expandedKeys: ["/", "/var"],
  };

  assert.notDeepEqual(expandedView.expandedKeys, renderedView.expandedKeys);
  assert.equal(sameDirectorySession(expandedView, renderedView), true);
  assert.equal(sameDirectorySession(expandedView, { ...renderedView, sftpId: "sftp-b" }), false);
});

test("manually collapsed current-path parent stays collapsed until the path changes", () => {
  const collapsedKeys = ["/"];

  const unchangedPath = expandDirectoryParentsForPathChange(
    collapsedKeys,
    "/sys/block",
    "/sys/block",
  );
  assert.strictEqual(unchangedPath, collapsedKeys);
  assert.deepEqual(unchangedPath, ["/"]);

  const changedPath = expandDirectoryParentsForPathChange(
    unchangedPath,
    "/sys/block",
    "/usr/bin",
  );
  assert.deepEqual(changedPath, ["/", "/usr"]);
});
