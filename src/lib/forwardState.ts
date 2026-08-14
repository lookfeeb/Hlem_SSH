import type { ForwardInfo, ForwardStatusEvent } from "../types";

export function applyForwardStatus(
  current: ForwardInfo[],
  payload: ForwardStatusEvent,
): ForwardInfo[] {
  if (payload.status === "canceled" || payload.status === "completed") {
    return current.filter((forward) => forward.forwardId !== payload.forwardId);
  }
  const existing = current.findIndex((forward) => forward.forwardId === payload.forwardId);
  if (existing === -1) return [payload, ...current];
  const next = [...current];
  next[existing] = payload;
  return next;
}

export function normalizeForwardList(items: ForwardInfo[]): ForwardInfo[] {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.startedAt);
    const rightTime = Date.parse(right.startedAt);
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });
}
