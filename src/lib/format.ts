import type { RemoteFileEntry, UsageMetric } from "../types";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

const beijingDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const beijingDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const beijingMonthDayTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

type ByteFormatOptions = {
  zeroText?: string;
  invalidText?: string;
};

export function formatBytes(bytes: number, options: ByteFormatOptions = {}): string {
  if (!Number.isFinite(bytes)) return options.invalidText ?? "0 B";
  if (bytes <= 0) return options.zeroText ?? "0 B";
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

export function percent(metric: UsageMetric): number {
  if (metric.total === 0) return 0;
  return Math.round((metric.used / metric.total) * 100);
}

export function formatFileSize(entry: RemoteFileEntry): string {
  return entry.fileType === "directory" ? "-" : formatBytes(entry.size);
}

export function formatBeijingDateTime(value: string, fallback = value): string {
  const date = parseDateValue(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return beijingDateTimeFormatter.format(date);
}

export function formatBeijingDateTimeHyphen(value: string, fallback = value): string {
  const date = parseDateValue(value);
  if (Number.isNaN(date.getTime())) return fallback;
  const parts = beijingDateTimeFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function formatBeijingDate(value: string, fallback = value): string {
  const date = parseDateValue(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return beijingDateFormatter.format(date);
}

export function formatBeijingMonthDayTime(value: string, fallback = value, plainIsUtc = false): string {
  const date = parseDateValue(value, plainIsUtc);
  if (Number.isNaN(date.getTime())) return fallback;
  const parts = beijingMonthDayTimeFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function formatBeijingCompactTimestamp(date = new Date()): string {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = beijing.getUTCFullYear();
  const month = String(beijing.getUTCMonth() + 1).padStart(2, "0");
  const day = String(beijing.getUTCDate()).padStart(2, "0");
  const hour = String(beijing.getUTCHours()).padStart(2, "0");
  const minute = String(beijing.getUTCMinutes()).padStart(2, "0");
  const second = String(beijing.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function parseDateValue(value: string, plainIsUtc = false): Date {
  if (!plainIsUtc || value.includes("T") || value.includes("Z")) return new Date(value);
  return new Date(`${value}Z`);
}
