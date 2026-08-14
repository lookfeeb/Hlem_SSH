import type { Dispatch, MutableRefObject, SetStateAction } from "react";

export function commitRefState<T>(
  stateRef: MutableRefObject<T>,
  setState: Dispatch<SetStateAction<T>>,
  action: SetStateAction<T>,
) {
  const next = typeof action === "function"
    ? (action as (current: T) => T)(stateRef.current)
    : action;
  stateRef.current = next;
  setState(next);
  return next;
}
