import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteDownloadPlan,
  joinLocalDownloadPath,
  type RemoteDownloadSelection,
} from "../src/app/remoteDownloadPlan";
import type { RemoteFileEntry } from "../src/types";

function entry(path: string, name: string, fileType: RemoteFileEntry["fileType"]): RemoteFileEntry {
  return {
    key: path,
    name,
    path,
    fileType,
    size: 0,
    modifiedAt: "",
    permissions: "",
    owner: "",
  };
}

test("递归下载计划保留顶层目录、嵌套文件和空目录", async () => {
  const listings = new Map<string, RemoteFileEntry[]>([
    ["/root/pkg", [
      entry("/root/pkg/a.txt", "a.txt", "file"),
      entry("/root/pkg/empty", "empty", "directory"),
      entry("/root/pkg/nested", "nested", "directory"),
    ]],
    ["/root/pkg/empty", []],
    ["/root/pkg/nested", [entry("/root/pkg/nested/b.log", "b.log", "file")]],
  ]);
  const selections: RemoteDownloadSelection[] = [
    { remotePath: "/root/pkg", fileName: "pkg", fileType: "directory" },
  ];

  const plan = await buildRemoteDownloadPlan(selections, async (path) => listings.get(path) ?? []);

  assert.deepEqual(plan.directories, ["pkg", "pkg/empty", "pkg/nested"]);
  assert.deepEqual(plan.files, [
    { remotePath: "/root/pkg/a.txt", relativePath: "pkg/a.txt" },
    { remotePath: "/root/pkg/nested/b.log", relativePath: "pkg/nested/b.log" },
  ]);
});

test("递归下载计划支持文件与目录混合选择", async () => {
  const plan = await buildRemoteDownloadPlan(
    [
      { remotePath: "/root/readme.md", fileName: "readme.md", fileType: "file" },
      { remotePath: "/root/logs", fileName: "logs", fileType: "directory" },
    ],
    async (path) => path === "/root/logs"
      ? [entry("/root/logs/app.log", "app.log", "file")]
      : [],
  );

  assert.deepEqual(plan.directories, ["logs"]);
  assert.deepEqual(plan.files, [
    { remotePath: "/root/readme.md", relativePath: "readme.md" },
    { remotePath: "/root/logs/app.log", relativePath: "logs/app.log" },
  ]);
});

test("目录读取失败会指出具体远端路径和底层原因", async () => {
  await assert.rejects(
    buildRemoteDownloadPlan(
      [{ remotePath: "/root/private", fileName: "private", fileType: "directory" }],
      async () => { throw new Error("Permission denied"); },
    ),
    /读取远端目录 \/root\/private 失败：Permission denied/,
  );
});

test("拒绝可能造成路径穿越的远端名称", async () => {
  await assert.rejects(
    buildRemoteDownloadPlan(
      [{ remotePath: "/root/data", fileName: "data", fileType: "directory" }],
      async () => [entry("/root/data/..", "..", "directory")],
    ),
    /不安全的名称/,
  );
});

test("本地下载路径兼容 Windows 目录和远端相对路径", () => {
  assert.equal(
    joinLocalDownloadPath("C:\\Users\\Admin\\Downloads\\", "pkg/nested/a.txt"),
    "C:\\Users\\Admin\\Downloads/pkg/nested/a.txt",
  );
});
