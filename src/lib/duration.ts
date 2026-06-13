export function formatElapsedSince(startedAt?: string | null, now = Date.now()) {
  if (!startedAt) return "-";
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "-";
  return formatDurationMs(Math.max(0, now - started));
}

export function formatDurationMs(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const time = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  return days > 0 ? `${days} 天 ${time}` : time;
}

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}
