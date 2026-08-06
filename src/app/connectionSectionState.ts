const TRANSIENT_CONNECTION_SECTION_IDS = new Set(["search"]);

export function normalizeCollapsedConnectionSectionIds(sectionIds: Iterable<string>) {
  const normalized: string[] = [];
  for (const value of sectionIds) {
    const sectionId = value.trim();
    if (!sectionId || normalized.includes(sectionId)) continue;
    normalized.push(sectionId);
  }
  return normalized;
}

export function toggleCollapsedConnectionSectionId(sectionIds: Iterable<string>, sectionId: string) {
  const normalized = normalizeCollapsedConnectionSectionIds(sectionIds);
  const next = new Set(normalized);
  if (next.has(sectionId)) next.delete(sectionId);
  else next.add(sectionId);
  return [...next];
}

export function shouldPersistConnectionSectionId(sectionId: string) {
  return !TRANSIENT_CONNECTION_SECTION_IDS.has(sectionId);
}
