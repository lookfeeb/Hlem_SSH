import assert from "node:assert/strict";
import test from "node:test";
import {
  emitSftpDirectoryInvalidation,
  onSftpDirectoryInvalidation,
} from "../src/lib/sftpDirectoryEvents";

test("SFTP directory invalidations are normalized, deduplicated, and unsubscribable", () => {
  const received: Array<{ sftpId: string; directories: string[] }> = [];
  const unsubscribe = onSftpDirectoryInvalidation((event) => received.push(event));

  emitSftpDirectoryInvalidation("sftp-a", ["/var/", "/var", "//tmp//"]);
  unsubscribe();
  emitSftpDirectoryInvalidation("sftp-a", ["/ignored"]);

  assert.deepEqual(received, [{ sftpId: "sftp-a", directories: ["/var", "/tmp"] }]);
});
