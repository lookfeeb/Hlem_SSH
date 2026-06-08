import type { AppInfo, UpdateInfo } from "../types";
import { browserUnavailable, call } from "./bridge";

export type LocalExpandedEntry = {
  localPath: string;
  relativePath: string;
};

export type ApiServerInfo = {
  running: boolean;
  port: number;
  apiKey: string;
};

export type ApiLogEntry = {
  timestamp: string;
  action: string;
  detail: string;
  success: boolean;
  durationMs: number;
  response?: string | null;
};

type GitHubRelease = {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  assets?: Array<{
    name?: string;
    browser_download_url?: string;
    size?: number;
  }>;
};

type SignedUpdateManifest = {
  version?: number;
  appVersion?: string;
  latestVersion?: string;
  tagName?: string;
  htmlUrl?: string;
  body?: string;
  publishedAt?: string;
  assets?: Array<{
    platform?: string;
    arch?: string;
    name?: string;
    url?: string;
    downloadUrl?: string;
    size?: number;
    sha256?: string;
  }>;
};

const DEFAULT_UPDATE_REPO = "lookfeeb/Hlem_SSH";
const UPDATE_REPO = import.meta.env.VITE_HELM_UPDATE_REPO?.trim() || DEFAULT_UPDATE_REPO;
const UPDATE_PUBLIC_KEY_PEM = import.meta.env.VITE_HELM_UPDATE_PUBLIC_KEY_PEM?.trim() || "";

export const appApi = {
  info: () => call<AppInfo>("app_info", browserInfo),
  updateRepo: () => UPDATE_REPO,
  checkUpdate,
  fetchTextUrl: (url: string) => call<string>("fetch_text_url", () => browserFetchText(url), { url }),
  downloadUpdate: (url: string, fileName?: string | null) =>
    call<string>("download_update", () => browserDownload(url), { url, fileName }),
  downloadSignedUpdate: (url: string, fileName?: string | null, sha256?: string | null) =>
    call<string>("download_update", () => browserDownload(url), { url, fileName, sha256 }),
  installUpdate: (installerPath: string) =>
    call<void>("install_update", () => browserUnavailable("安装更新"), { installerPath }),
  openDatabaseDir: () => call<void>("open_database_dir", () => undefined),
  openPathDir: (path: string) => call<void>("open_path_dir", () => undefined, { path }),
  openExternalUrl: (url: string) => call<void>("open_external_url", () => browserOpenUrl(url), { url }),
  expandLocalPaths: (paths: string[]) =>
    call<LocalExpandedEntry[]>("local_expand_paths", () => browserUnavailable("本地目录展开"), { paths }),
  apiServerStart: (port: number, allowedSessionIds?: string[] | string | null) => {
    const ids = Array.isArray(allowedSessionIds)
      ? allowedSessionIds
      : allowedSessionIds
        ? [allowedSessionIds]
        : [];
    return call<ApiServerInfo>("api_server_start", () => browserUnavailable("API 服务"), {
      port,
      allowedSessionId: ids[0] ?? null,
      allowedSessionIds: ids,
    });
  },
  apiServerStop: () =>
    call<void>("api_server_stop", () => browserUnavailable("API 服务"), undefined),
  apiServerUpdateSessions: (allowedSessionIds?: string[] | string | null) => {
    const ids = Array.isArray(allowedSessionIds)
      ? allowedSessionIds
      : allowedSessionIds
        ? [allowedSessionIds]
        : [];
    return call<ApiServerInfo>("api_server_update_sessions", () => browserUnavailable("API 服务"), {
      allowedSessionId: ids[0] ?? null,
      allowedSessionIds: ids,
    });
  },
  apiServerStatus: () =>
    call<ApiServerInfo>("api_server_status", () => ({ running: false, port: 0, apiKey: "" }), undefined),
  apiServerRegenerateKey: () =>
    call<ApiServerInfo>("api_server_regenerate_key", () => browserUnavailable("API 服务"), undefined),
  apiServerLogs: () =>
    call<ApiLogEntry[]>("api_server_logs", () => [], undefined),
};

async function checkUpdate(currentVersion: string, currentArch = ""): Promise<UpdateInfo | null> {
  if (!UPDATE_REPO) return null;
  if (UPDATE_PUBLIC_KEY_PEM) return checkSignedManifest(currentVersion, currentArch);
  return checkGitHubRelease(currentVersion);
}

async function checkSignedManifest(currentVersion: string, currentArch: string): Promise<UpdateInfo | null> {
  const manifestUrl = `https://github.com/${UPDATE_REPO}/releases/latest/download/latest.json`;
  const signatureUrl = `${manifestUrl}.sig`;
  const [manifestText, signature] = await Promise.all([
    appApi.fetchTextUrl(manifestUrl),
    appApi.fetchTextUrl(signatureUrl),
  ]);
  const verified = await verifyManifestSignature(manifestText, signature.trim());
  if (!verified) throw new Error("更新清单签名验证失败");

  const manifest = JSON.parse(manifestText) as SignedUpdateManifest;
  const tagName = manifest.tagName || "";
  const latestVersion = normalizeVersion(manifest.appVersion || manifest.latestVersion || tagName);
  if (!latestVersion) throw new Error("最新版本号无效");
  const selected = selectManifestAsset(manifest.assets ?? [], currentArch);
  return {
    currentVersion,
    latestVersion,
    tagName: tagName || `v${latestVersion}`,
    htmlUrl: manifest.htmlUrl || `https://github.com/${UPDATE_REPO}/releases/latest`,
    body: manifest.body ?? "",
    publishedAt: manifest.publishedAt ?? "",
    asset: selected,
    hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
    signatureVerified: true,
  };
}

async function checkGitHubRelease(currentVersion: string): Promise<UpdateInfo | null> {
  const release = JSON.parse(await appApi.fetchTextUrl(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`)) as GitHubRelease;
  const tagName = release.tag_name || release.name || "";
  const latestVersion = normalizeVersion(tagName);
  if (!latestVersion) throw new Error("最新版本号无效");
  const asset = selectWindowsAsset(release.assets ?? []);
  return {
    currentVersion,
    latestVersion,
    tagName,
    htmlUrl: release.html_url ?? `https://github.com/${UPDATE_REPO}/releases/latest`,
    body: release.body ?? "",
    publishedAt: release.published_at ?? "",
    asset,
    hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
    signatureVerified: false,
  };
}

function selectManifestAsset(assets: NonNullable<SignedUpdateManifest["assets"]>, currentArch: string) {
  const arch = normalizeArch(currentArch);
  const candidates = assets
    .filter((asset) => (asset.platform ?? "windows").toLowerCase() === "windows")
    .filter((asset) => asset.name && (asset.url || asset.downloadUrl))
    .filter((asset) => /\.exe$/i.test(asset.name ?? ""));
  const exact = candidates.find((asset) => normalizeArch(asset.arch ?? "") === arch);
  const asset = exact ?? candidates[0];
  const downloadUrl = asset?.url || asset?.downloadUrl;
  if (!asset?.name || !downloadUrl) return null;
  if (!asset.sha256) throw new Error("更新清单缺少安装包 SHA256");
  return {
    name: asset.name,
    downloadUrl,
    size: asset.size ?? 0,
    sha256: asset.sha256,
  };
}

function selectWindowsAsset(assets: NonNullable<GitHubRelease["assets"]>) {
  const candidates = assets
    .filter((asset) => asset.name && asset.browser_download_url)
    .filter((asset) => /\.exe$/i.test(asset.name ?? ""))
    .sort((left, right) => assetRank(left.name ?? "") - assetRank(right.name ?? ""));
  const asset = candidates[0];
  if (!asset?.name || !asset.browser_download_url) return null;
  return {
    name: asset.name,
    downloadUrl: asset.browser_download_url,
    size: asset.size ?? 0,
  };
}

function assetRank(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("setup")) return 0;
  if (lower.endsWith(".exe")) return 1;
  return 9;
}

function normalizeArch(value: string) {
  const lower = value.toLowerCase();
  if (["x64", "x86_64", "amd64"].includes(lower)) return "x64";
  if (["x86", "i686", "ia32"].includes(lower)) return "x86";
  if (["arm64", "aarch64"].includes(lower)) return "arm64";
  return lower;
}

async function verifyManifestSignature(manifestText: string, signatureBase64: string) {
  const key = await crypto.subtle.importKey(
    "spki",
    pemToArrayBuffer(UPDATE_PUBLIC_KEY_PEM),
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "RSA-PSS", saltLength: 32 },
    key,
    base64ToBytes(signatureBase64),
    new TextEncoder().encode(manifestText),
  );
}

function pemToArrayBuffer(value: string) {
  const normalized = value.replace(/\\n/g, "\n");
  const base64 = normalized
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s/g, "");
  return base64ToBytes(base64).buffer;
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, "").match(/\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?/i)?.[0] ?? "";
}

function compareVersions(left: string, right: string) {
  const a = left.split(/[+-]/)[0].split(".").map(Number);
  const b = right.split(/[+-]/)[0].split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function browserInfo(): AppInfo {
  return {
    version: "0.1.0",
    os: navigator.platform || "browser",
    arch: "browser",
    databasePath: "浏览器 localStorage",
  };
}

function browserDownload(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve("已在浏览器中打开下载地址");
}

function browserOpenUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

async function browserFetchText(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`读取远程内容失败：HTTP ${response.status}`);
  return response.text();
}
