export type ApiLogLike = {
  timestamp: string;
  action: string;
  detail: string;
  success: boolean;
  durationMs: number;
  response?: string | null;
};

export function apiLogEntryKey(log: ApiLogLike) {
  return [
    log.timestamp,
    log.action,
    log.durationMs,
    log.success ? 1 : 0,
    log.detail,
    log.response ?? "",
  ].join("|");
}

export function mergeApiLogEntries<T extends ApiLogLike>(
  current: readonly T[],
  incoming: readonly T[],
  limit = 100,
): T[] {
  const byKey = new Map<string, T>();
  for (const log of [...current, ...incoming]) {
    byKey.set(apiLogEntryKey(log), log);
  }
  const merged = [...byKey.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}
