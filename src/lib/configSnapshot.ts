import type { ConfigSnapshot } from "../types";

export function isConfigSnapshotCurrent(
  current: ConfigSnapshot | undefined,
  candidate: ConfigSnapshot,
) {
  return !current || candidate.revision >= current.revision;
}
