import assert from "node:assert/strict";
import test from "node:test";
import { parseSystemInfo } from "../src/lib/systemInfo.ts";

test("preserves distribution versions and full kernel releases amid login banners", () => {
  assert.deepEqual(parseSystemInfo(
    "Welcome to Ubuntu\r\n__HELM_OS__ Ubuntu 24.04.1 LTS\r\n__HELM_KERNEL__ Linux 6.8.0-48-generic\r\n",
  ), {
    operatingSystem: "Ubuntu 24.04.1 LTS",
    kernel: "Linux 6.8.0-48-generic",
  });
});

test("supports names containing spaces, parentheses and non-Linux kernels", () => {
  assert.deepEqual(parseSystemInfo(
    "__HELM_OS__ Debian GNU/Linux 12 (bookworm)\n__HELM_KERNEL__ Linux 6.1.0-28-amd64",
  ), {
    operatingSystem: "Debian GNU/Linux 12 (bookworm)",
    kernel: "Linux 6.1.0-28-amd64",
  });
  assert.deepEqual(parseSystemInfo("__HELM_OS__ macOS 15.1\n__HELM_KERNEL__ Darwin 24.1.0"), {
    operatingSystem: "macOS 15.1",
    kernel: "Darwin 24.1.0",
  });
});

test("retains available information if one collector is unavailable", () => {
  assert.deepEqual(parseSystemInfo("__HELM_OS__ \n__HELM_KERNEL__ Linux 6.12.0\n"), {
    operatingSystem: "",
    kernel: "Linux 6.12.0",
  });
  assert.deepEqual(parseSystemInfo("__HELM_OS__ Alpine Linux v3.20\n__HELM_KERNEL__ \n"), {
    operatingSystem: "Alpine Linux v3.20",
    kernel: "",
  });
});

test("does not mistake untagged output or empty results for system information", () => {
  for (const output of ["", "Permission denied", "__HELM_OS__ \n__HELM_KERNEL__ \n", "echo __HELM_OS__ Ubuntu"]) {
    assert.equal(parseSystemInfo(output), null);
  }
});
