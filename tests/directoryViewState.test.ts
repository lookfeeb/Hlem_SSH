import assert from "node:assert/strict";
import test from "node:test";
import {
  clearDirectoryViewStateCache,
  loadDirectoryViewState,
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
    { "/": rootEntries, "/home": homeEntries },
    ["/", "/home"],
  );

  const restored = loadDirectoryViewState({
    id: "session-a",
    sftpId: "sftp-a",
    currentPath: "/home",
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
    { "/": [directory("/stale")] },
    ["/", "/stale"],
  );

  const currentFiles = [directory("/home/current")];
  const restored = loadDirectoryViewState({
    id: "session-a",
    sftpId: "sftp-new",
    currentPath: "/home",
    files: currentFiles,
  });

  assert.equal(restored.entries["/"], undefined);
  assert.deepEqual(restored.entries["/home"], currentFiles);
  assert.deepEqual(restored.expandedKeys, ["/"]);
});

test("the selected directory itself stays collapsed while its parents remain visible", () => {
  clearDirectoryViewStateCache();
  saveDirectoryViewState(
    "session-a",
    "sftp-a",
    { "/": [directory("/root")], "/root": [directory("/root/app")] },
    ["/"],
  );

  const root = loadDirectoryViewState({
    id: "session-a",
    sftpId: "sftp-a",
    currentPath: "/root",
    files: [directory("/root/app")],
  });
  assert.deepEqual(root.expandedKeys, ["/"]);

  const app = loadDirectoryViewState({
    id: "session-a",
    sftpId: "sftp-a",
    currentPath: "/root/app",
    files: [],
  });
  assert.deepEqual(app.expandedKeys, ["/", "/root"]);
});
