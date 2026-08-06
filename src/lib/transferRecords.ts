import type { BackupRecord, FileSaveRecord, TransferInfo } from "../types";
import { formatBytes } from "./format";
import { getAnyPathBaseName } from "./path";

export function transferName(transfer: TransferInfo) {
  return getAnyPathBaseName(transfer.localPath) || getAnyPathBaseName(transfer.remotePath) || transfer.remotePath;
}

export function transferSourcePath(transfer: TransferInfo) {
  return transfer.direction === "upload" ? parentPath(transfer.localPath) : parentPath(transfer.remotePath);
}

export function transferTargetPath(transfer: TransferInfo) {
  return transfer.direction === "upload" ? parentPath(transfer.remotePath) : parentPath(transfer.localPath);
}

function parentPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized || "/";
  if (/^[A-Za-z]:$/.test(normalized.slice(0, index))) return `${normalized.slice(0, index)}/`;
  return normalized.slice(0, index);
}

export function isActiveTransfer(transfer: TransferInfo) {
  return transfer.status === "queued" || transfer.status === "running" || transfer.status === "paused";
}

export function isTransferDone(transfer: TransferInfo) {
  return transfer.bytesTotal > 0 && transfer.bytesDone >= transfer.bytesTotal;
}

export function mergeTransferInfo(current: TransferInfo, incoming: TransferInfo) {
  if (current.transferId !== incoming.transferId) return incoming;

  // Tauri events can overtake the original invoke result for very small files.
  // Never let a late queued/running snapshot revive an already finished task.
  if (isTerminalTransferStatus(current.status) && !isTerminalTransferStatus(incoming.status)) {
    return current;
  }

  const currentUpdatedAt = transferUpdatedAt(current);
  const incomingUpdatedAt = transferUpdatedAt(incoming);
  if (incomingUpdatedAt < currentUpdatedAt) return current;
  if (incomingUpdatedAt === currentUpdatedAt) {
    if (incoming.bytesDone < current.bytesDone) return current;
    if (transferStatusRank(incoming.status) < transferStatusRank(current.status)) return current;
  }

  return incoming;
}

function isTerminalTransferStatus(status: TransferInfo["status"]) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function transferStatusRank(status: TransferInfo["status"]) {
  if (isTerminalTransferStatus(status)) return 2;
  if (status === "running" || status === "paused") return 1;
  return 0;
}

function transferUpdatedAt(transfer: TransferInfo) {
  const value = Date.parse(transfer.updatedAt || transfer.createdAt);
  return Number.isFinite(value) ? value : 0;
}

export function transferStatusText(transfer: TransferInfo) {
  if (isTransferDone(transfer)) return "已完成";
  const map: Record<TransferInfo["status"], string> = {
    queued: "等待中",
    running: "传输中",
    paused: "已暂停",
    completed: "已完成",
    failed: "失败",
    canceled: "已停止",
  };
  return map[transfer.status];
}

export function transferStatusTone(transfer: TransferInfo) {
  if (isTransferDone(transfer)) return "success";
  if (transfer.status === "failed" || transfer.status === "canceled") return "failed";
  return "warning";
}

export function transferProgressStatus(transfer: TransferInfo) {
  if (isTransferDone(transfer)) return "success";
  if (transfer.status === "failed" || transfer.status === "canceled") return "exception";
  if (transfer.status === "completed") return "success";
  return "active";
}

export function formatTransferSpeed(transfer: TransferInfo) {
  if (transfer.status !== "running" || transfer.speedKbps <= 0) return "0 KB/s";
  return `${formatBytes(transfer.speedKbps * 1024)}/s`;
}

export function saveStatusText(status: FileSaveRecord["status"]) {
  if (status === "saving") return "保存中";
  if (status === "success") return "保存成功";
  return "保存失败";
}

export function backupStatusText(status: BackupRecord["status"]) {
  return status === "success" ? "备份成功" : "备份失败";
}

export function backupKindText(kind: BackupRecord["targetKind"]) {
  if (kind === "local") return "本地";
  if (kind === "webdav") return "WebDAV";
  if (kind === "s3") return "S3";
  if (kind === "cloud") return "云端";
  return kind;
}
