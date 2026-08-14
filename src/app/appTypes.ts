import type { SessionInput } from "../types";

export type SessionModalState =
  | { requestId: string; mode: "create"; input: SessionInput }
  | { requestId: string; mode: "edit"; sessionId: string; input: SessionInput };
