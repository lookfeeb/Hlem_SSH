export function readJsonStorage<T>(
  key: string,
  fallback: T,
  normalize?: (value: unknown) => T,
): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return normalize ? normalize(parsed) : (parsed as T);
  } catch (error) {
    console.debug(`[helm] failed to read localStorage key ${key}:`, error);
    return fallback;
  }
}

export function writeJsonStorage(key: string, value: unknown): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.debug(`[helm] failed to write localStorage key ${key}:`, error);
    return false;
  }
}
