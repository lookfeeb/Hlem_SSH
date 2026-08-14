export async function loadStableSnapshot<T>(
  query: () => Promise<T>,
  readEventVersion: () => number,
  isCurrent: () => boolean,
): Promise<T | undefined> {
  while (isCurrent()) {
    const eventVersion = readEventVersion();
    const snapshot = await query();
    if (!isCurrent()) return undefined;
    if (eventVersion !== readEventVersion()) continue;
    return snapshot;
  }
  return undefined;
}
