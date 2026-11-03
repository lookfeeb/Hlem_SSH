import assert from "node:assert/strict";
import test from "node:test";
import { comparePathName, sortRemoteEntries } from "../src/lib/fileClassify";
import type { RemoteFileEntry } from "../src/types";

test("large-directory ordering preserves directory priority and natural filename order", () => {
  const entry = (name: string, fileType: RemoteFileEntry["fileType"] = "file"): RemoteFileEntry => ({name,fileType,key:name,path:`/${name}`,size:0,modifiedAt:"",permissions:"",owner:""});
  const input = [entry("file10"), entry("Z.json", "directory"), entry("file2"), entry("link", "symlink")];
  assert.deepEqual(sortRemoteEntries(input).map(x => x.name), ["Z.json", "link", "file2", "file10"]);
  assert.equal(input[0].name, "file10");
  assert.ok(comparePathName("/data/file2", "/data/file10") < 0);
});
