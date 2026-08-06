import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCollapsedConnectionSectionIds,
  shouldPersistConnectionSectionId,
  toggleCollapsedConnectionSectionId,
} from "../src/app/connectionSectionState";
import { sortConnectionsByCount, sortConnectionsByCreatedAt } from "../src/app/connectionOrdering";

test("connection section state is trimmed, deduplicated, and toggled predictably", () => {
  assert.deepEqual(
    normalizeCollapsedConnectionSectionIds(["recent", " recent ", "", "group-a"]),
    ["recent", "group-a"],
  );
  assert.deepEqual(toggleCollapsedConnectionSectionId(["recent"], "group-a"), ["recent", "group-a"]);
  assert.deepEqual(toggleCollapsedConnectionSectionId(["recent", "group-a"], "recent"), ["group-a"]);
});

test("search result collapse state remains transient", () => {
  assert.equal(shouldPersistConnectionSectionId("recent"), true);
  assert.equal(shouldPersistConnectionSectionId("search"), false);
});

test("recent connections sort only by connection count and keep ties stable", () => {
  const sessions = [
    { id: "old-low", connectionCount: 1 },
    { id: "old-high", connectionCount: 5 },
    { id: "new-high", connectionCount: 5 },
    { id: "never", connectionCount: 0 },
  ];

  assert.deepEqual(
    sortConnectionsByCount(sessions).map((session) => session.id),
    ["old-high", "new-high", "old-low", "never"],
  );
  assert.deepEqual(sessions.map((session) => session.id), ["old-low", "old-high", "new-high", "never"]);
});

test("normal groups keep oldest connections above newly added connections", () => {
  const sessions = [
    { id: "new", createdAt: "2026-08-02T02:00:00Z" },
    { id: "old", createdAt: "2026-08-01T02:00:00Z" },
    { id: "same-a", createdAt: "2026-08-02T03:00:00Z" },
    { id: "same-b", createdAt: "2026-08-02T03:00:00Z" },
  ];

  assert.deepEqual(
    sortConnectionsByCreatedAt(sessions).map((session) => session.id),
    ["old", "new", "same-a", "same-b"],
  );
});
