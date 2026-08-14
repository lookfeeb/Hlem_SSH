export type ConnectingSessionCandidate = {
  id: string;
  configId?: string | null;
};

export type ReconnectCountdownScheduler = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
};

type ReconnectCountdownOptions = {
  delayMs: number;
  onTick: (remainingSeconds: number) => void;
  onElapsed: () => void;
  scheduler: ReconnectCountdownScheduler;
};

export class ReconnectCountdown {
  private readonly deadlineMs: number;
  private timer: number | null = null;
  private lastRemainingSeconds: number | null = null;
  private started = false;
  private stopped = false;

  constructor(private readonly options: ReconnectCountdownOptions) {
    this.deadlineMs = options.scheduler.now() + Math.max(0, options.delayMs);
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.refresh();
  }

  cancel() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      this.options.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private refresh() {
    if (this.stopped) return;
    const remainingMs = this.deadlineMs - this.options.scheduler.now();
    if (remainingMs <= 0) {
      this.stopped = true;
      this.timer = null;
      this.options.onElapsed();
      return;
    }

    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    if (remainingSeconds !== this.lastRemainingSeconds) {
      this.lastRemainingSeconds = remainingSeconds;
      this.options.onTick(remainingSeconds);
    }

    const untilNextSecond = remainingMs - (remainingSeconds - 1) * 1000;
    this.timer = this.options.scheduler.setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, Math.max(1, Math.ceil(untilNextSecond)));
  }
}

export function addConnectingSessionId(
  current: ReadonlySet<string>,
  sessionId: string,
): Set<string> | null {
  if (current.has(sessionId)) return null;
  const next = new Set(current);
  next.add(sessionId);
  return next;
}

export function removeConnectingSessionIds(
  current: ReadonlySet<string>,
  sessionIds: Iterable<string>,
): Set<string> {
  const next = new Set(current);
  for (const sessionId of sessionIds) next.delete(sessionId);
  return next;
}

export function connectingSessionIdsFor(
  requestedId: string,
  sessions: readonly ConnectingSessionCandidate[],
  connectingSessionIds: ReadonlySet<string>,
): string[] {
  if (connectingSessionIds.has(requestedId)) return [requestedId];
  return sessions
    .filter((session) =>
      connectingSessionIds.has(session.id) && (session.configId || session.id) === requestedId,
    )
    .map((session) => session.id);
}

export function remainingOpenSessionIds(
  currentIds: readonly string[],
  closingIds: ReadonlySet<string>,
): string[] {
  return currentIds.filter((id) => !closingIds.has(id));
}

export function activeSessionIdAfterClose(
  currentActiveId: string,
  remainingIds: readonly string[],
  closingIds: ReadonlySet<string>,
): string {
  return closingIds.has(currentActiveId) ? remainingIds[0] ?? "" : currentActiveId;
}

export function normalizeDisconnectReason(reason?: string | null) {
  const value = reason?.trim();
  if (
    !value ||
    value.toLowerCase() === "disconnected" ||
    value === "SSH 连接已断开；服务器未返回具体原因"
  ) {
    return "服务器未返回具体原因";
  }

  const withoutDuplicatePrefix = value
    .replace(/^连接(?:已|意外)?断开(?:[，,；;]\s*原因)?[：:，,；;\s]*/u, "")
    .trim();
  const timeout = withoutDuplicatePrefix.match(
    /^SSH 连接超时[：:]\s*(.+?)未在\s*(\d+)\s*毫秒内完成[。.]?$/u,
  );
  if (timeout) {
    return `SSH 建连超时（${timeout[1].trim()}超过 ${formatMilliseconds(Number(timeout[2]))}）`;
  }
  return withoutDuplicatePrefix || "服务器未返回具体原因";
}

export function formatReconnectCountdownNotice(options: {
  previousAttempts: number;
  nextAttempt: number;
  remainingSeconds: number;
  failureReason?: string | null;
}) {
  const phase = options.previousAttempts > 0
    ? `第 ${options.previousAttempts} 次重连失败`
    : "连接中断";
  const reason = options.failureReason
    ? `：${normalizeDisconnectReason(options.failureReason)}`
    : "";
  return `${phase}${reason}；第 ${options.nextAttempt} 次重连倒计时：${Math.max(1, Math.ceil(options.remainingSeconds))} 秒`;
}

function formatMilliseconds(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "未知时长";
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  const seconds = value / 1000;
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(1))} 秒`;
}
