import assert from "node:assert/strict";
import test from "node:test";
import { formatUptimeSeconds } from "../src/lib/duration.ts";

test("formats server uptime as cumulative hours, minutes, and seconds", () => {
  assert.equal(formatUptimeSeconds(7), "0 小时 00 分钟 07 秒");
  assert.equal(formatUptimeSeconds(25 * 3_600 + 61), "25 小时 01 分钟 01 秒");
  assert.equal(formatUptimeSeconds(400 * 86_400), "9600 小时 00 分钟 00 秒");
});
