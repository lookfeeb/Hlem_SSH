import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = resolve(root, "dist");
const manifest = JSON.parse(await readFile(resolve(dist, ".vite/manifest.json"), "utf8"));
function dependencies(entries) {
  const visited = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    assert.ok(manifest[key], `Missing manifest entry: ${key}`);
    visited.add(key);
    for (const dependency of manifest[key].imports ?? []) visit(dependency);
  }
  entries.forEach(visit);
  return visited;
}
async function bytes(entries) {
  const sizes = await Promise.all([...entries].map(key => stat(resolve(dist, manifest[key].file))));
  return sizes.reduce((sum, item) => sum + item.size, 0);
}
const shell = dependencies(["index.html"]);
const workspace = dependencies(["index.html", "src/App.tsx"]);
for (const deferred of ["SessionWorkspace", "EditorWindowApp", "SettingsModal", "MigrationGate"]) {
  const entry = `src/components/${deferred}.tsx`;
  assert.ok(manifest[entry], `Missing lazy entry: ${deferred}`);
  assert.ok(!workspace.has(entry), `${deferred} must not load before it is used`);
}
const shellBytes = await bytes(shell);
const workspaceBytes = await bytes(workspace);
assert.ok(shellBytes < 300_000, `Startup shell exceeded 300 kB: ${shellBytes}`);
assert.ok(workspaceBytes < 1_000_000, `Initial workspace exceeded 1 MB: ${workspaceBytes}`);
console.log(JSON.stringify({ shellBytes, workspaceBytes, deferredModules: "verified" }, null, 2));
