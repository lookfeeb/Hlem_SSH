import type { UpdateInfo } from "../types";

export function normalizeUpdateVersion(latestVersion: string | undefined, tagName: string | undefined) {
  const candidate = (latestVersion || tagName || "").trim();
  if (!candidate) return "";
  return candidate.replace(/^v/i, "");
}

export function updateAssetKey(update: UpdateInfo | null | undefined) {
  if (!update?.hasUpdate || !update.asset) return null;
  return [normalizeUpdateVersion(update.latestVersion, update.tagName), update.asset.downloadUrl, update.asset.sha256 ?? ""].join("\u0000");
}
