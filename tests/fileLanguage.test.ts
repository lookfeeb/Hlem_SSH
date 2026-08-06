import assert from "node:assert/strict";
import test from "node:test";
import { detectFileLanguage } from "../src/lib/fileLanguage.ts";
import { detectLineEnding, detectTextEncoding } from "../src/lib/textFileMetadata.ts";

test("recognizes the original type behind common backup suffixes", () => {
  assert.equal(detectFileLanguage("/root/.profile.bak-cargo-env-20260616050251").id, "shell");
  assert.equal(detectFileLanguage("/etc/50-cloud-init.yaml.bak.1779123456").id, "yaml");
  assert.equal(detectFileLanguage("/etc/nginx.conf.old").id, "nginx");
});

test("falls back to content detection when the file name has no useful type", () => {
  assert.equal(detectFileLanguage("/tmp/startup", "#!/usr/bin/env bash\necho ready\n").id, "shell");
  assert.equal(detectFileLanguage("/tmp/cloud-config", "#cloud-config\nusers: []\n").id, "yaml");
  assert.equal(detectFileLanguage("/tmp/settings", "{\"enabled\":true}\n").id, "json");
});

test("reports verified UTF-8 metadata and actual line endings", () => {
  assert.equal(detectTextEncoding("hello"), "UTF-8");
  assert.equal(detectTextEncoding("\uFEFFhello"), "UTF-8 BOM");
  assert.equal(detectLineEnding("a\r\nb\r\n"), "CRLF");
  assert.equal(detectLineEnding("a\nb\n"), "LF");
  assert.equal(detectLineEnding("single line"), "无");
});
