export function normalizePath(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  return `/${parts.join("/")}`;
}

export function joinPath(basePath: string, name: string): string {
  return normalizePath(`${basePath}/${name}`);
}

export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter((part) => part.length > 0);
  parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export function getPathSegments(path: string): string[] {
  return normalizePath(path).split("/").filter((part) => part.length > 0);
}

export function getBaseName(path: string): string {
  const parts = getPathSegments(path);
  return parts[parts.length - 1] || "";
}

export function getAnyPathBaseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}
