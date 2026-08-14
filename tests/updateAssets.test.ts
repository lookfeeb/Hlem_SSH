import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUpdateVersion, updateAssetKey } from "../src/lib/updateAssets";
import type { UpdateInfo } from "../src/types";

function update(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    tagName: "v1.1.0",
    htmlUrl: "https://example.test/release",
    body: "",
    publishedAt: "2026-08-13T00:00:00Z",
    hasUpdate: true,
    asset: {
      name: "helm.exe",
      downloadUrl: "https://example.test/helm.exe",
      size: 1,
      sha256: "abc",
    },
    ...overrides,
  };
}

test("更新版本会去掉用于展示的 v 前缀", () => {
  assert.equal(normalizeUpdateVersion("", "V1.2.3"), "1.2.3");
  assert.equal(normalizeUpdateVersion(" 1.2.3 ", "v9.9.9"), "1.2.3");
});

test("没有有效更新时不会保留可安装资产身份", () => {
  assert.equal(updateAssetKey(update({ hasUpdate: false })), null);
  assert.equal(updateAssetKey(update({ asset: null })), null);
  assert.equal(updateAssetKey(null), null);
});

test("资产身份覆盖版本、下载地址和校验值", () => {
  const first = updateAssetKey(update());
  assert.notEqual(first, updateAssetKey(update({ latestVersion: "1.2.0" })));
  assert.notEqual(first, updateAssetKey(update({ asset: { name: "helm.exe", downloadUrl: "https://example.test/other.exe", size: 1, sha256: "abc" } })));
  assert.notEqual(first, updateAssetKey(update({ asset: { name: "helm.exe", downloadUrl: "https://example.test/helm.exe", size: 1, sha256: "def" } })));
});
