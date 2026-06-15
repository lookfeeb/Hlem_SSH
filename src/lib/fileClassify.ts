import type { RemoteFileEntry } from "../types";
import { formatBeijingDateTimeHyphen } from "./format";
import { getBaseName } from "./path";

export type FileCategory =
  | "directory" | "archive" | "script" | "document" | "log" | "text"
  | "media" | "env" | "config" | "data" | "cert" | "binary" | "symlink" | "other";

export function fileExtension(name: string): string {
  const trimmed = name.replace(/\.+$/g, "");
  const index = trimmed.lastIndexOf(".");
  return index > 0 ? trimmed.slice(index + 1) : "";
}

export function isEnvFile(name: string): boolean {
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
}

export function isExecutable(entry: RemoteFileEntry): boolean {
  return entry.fileType === "file" && /x/.test(entry.permissions.slice(1));
}

export function fileCategory(entry: RemoteFileEntry): FileCategory {
  if (entry.fileType === "directory") return "directory";
  if (entry.fileType === "symlink") return "symlink";
  const name = entry.name.toLowerCase();
  const ext = fileExtension(name);
  if (isEnvFile(name)) return "env";
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war", "apk", "deb", "rpm", "dmg", "iso", "cab", "lz", "zst"].includes(ext)) return "archive";
  if (["sh", "bash", "zsh", "fish", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "ps1", "bat", "cmd", "lua", "rb", "pl", "php", "go", "rs", "c", "cpp", "h", "java", "kt", "swift", "r", "m"].includes(ext)) return "script";
  if (["pem", "crt", "cer", "der", "p12", "pfx", "key", "csr", "ca", "jks", "keystore", "truststore"].includes(ext)) return "cert";
  if (["md", "markdown", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf", "odt", "ods", "odp", "pages", "numbers", "epub"].includes(ext) || /^readme(?:\.|$)/.test(name)) return "document";
  if (["log", "out", "err", "trace"].includes(ext) || name.endsWith(".log.1")) return "log";
  if (["txt", "text", "ini", "properties", "service"].includes(ext)) return "text";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff", "tif", "psd", "ai", "raw", "cr2", "nef", "heic", "avif", "mp4", "mov", "avi", "mkv", "wmv", "flv", "webm", "m4v", "mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "opus"].includes(ext)) return "media";
  if (["json", "yaml", "yml", "toml", "xml", "csv", "tsv", "sql", "db", "sqlite", "parquet", "avro", "proto", "graphql", "types"].includes(ext)) return "data";
  if (["config", "conf", "cnf", "cfg", "htaccess", "editorconfig", "gitignore", "dockerignore"].includes(ext) || ["dockerfile", "nginx.conf", "package.json", "tsconfig.json", "makefile", "cmakelists.txt", "vagrantfile"].includes(name)) return "config";
  if (["exe", "bin", "run", "appimage", "msi", "dll", "so", "dylib", "a", "o", "elf", "com"].includes(ext) || isExecutable(entry)) return "binary";
  return "other";
}

export function entryGroupWeight(entry: RemoteFileEntry): number {
  if (entry.fileType === "directory") return 0;
  if (entry.fileType === "symlink") return 1;
  return 2;
}

export function compareEntryGroup(a: RemoteFileEntry, b: RemoteFileEntry): number {
  return entryGroupWeight(a) - entryGroupWeight(b);
}

export function compareEntryName(a: RemoteFileEntry, b: RemoteFileEntry): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

export function sortRemoteEntries(entries: RemoteFileEntry[]): RemoteFileEntry[] {
  return [...entries].sort((a, b) => compareEntryGroup(a, b) || compareEntryName(a, b));
}

export function filesBelongToDirectory(files: RemoteFileEntry[], dirPath: string): boolean {
  if (files.length === 0) return true;
  const normalized = dirPath === "/" ? "/" : dirPath.replace(/\/+$/, "");
  return files.every((f) => {
    const parent = f.path?.replace(/\/[^/]+$/, "") || "";
    return parent === normalized || (normalized === "/" && parent === "");
  });
}

export function formatBeijingModifiedTime(value: string): string {
  if (!value) return "-";
  return formatBeijingDateTimeHyphen(value);
}

export function comparePathName(a: string, b: string): number {
  const nameA = getBaseName(a) || a;
  const nameB = getBaseName(b) || b;
  return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
}
