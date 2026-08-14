import assert from "node:assert/strict";
import test from "node:test";
import { getParentPath, joinPath, normalizePath } from "../src/lib/path";

test("remote path normalization resolves dot segments without escaping root", () => {
  assert.equal(normalizePath("//tmp/./app/../logs/"), "/tmp/logs");
  assert.equal(normalizePath("/tmp/.."), "/");
  assert.equal(normalizePath("../../etc"), "/etc");
});

test("remote path helpers operate on canonical paths", () => {
  assert.equal(joinPath("/tmp/app", "../logs"), "/tmp/logs");
  assert.equal(getParentPath("/tmp/../etc/config"), "/etc");
});
