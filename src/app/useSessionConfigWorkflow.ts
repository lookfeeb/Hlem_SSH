import { useRef, useState } from "react";
import { vaultApi } from "../api/vaultApi";
import { createDefaultSessionInput } from "../lib/configMapping";
import { useMountedRef } from "../lib/reactLifecycle";
import { createNextSessionName, sessionConfigToInput } from "./appHelpers";
import type { SessionModalState } from "./appTypes";
import type { ConfigSnapshot, SessionInput } from "../types";

type UseSessionConfigWorkflowOptions = {
  configSnapshot: ConfigSnapshot | undefined;
  activeSessionId: string;
  applySnapshot: (snapshot: ConfigSnapshot, preferredSessionId?: string, preserveRuntime?: boolean) => void;
};

export function useSessionConfigWorkflow({
  configSnapshot,
  activeSessionId,
  applySnapshot,
}: UseSessionConfigWorkflowOptions) {
  const [sessionModal, setSessionModal] = useState<SessionModalState | null>(null);
  const mountedRef = useMountedRef();
  const sessionModalRef = useRef<SessionModalState | null>(null);
  const sessionCreatedCallbackRef = useRef<((sessionId: string) => void) | null>(null);

  function addSession(onCreated?: (sessionId: string) => void) {
    if (!configSnapshot) return;
    sessionCreatedCallbackRef.current = onCreated ?? null;
    openSessionModal({
      requestId: crypto.randomUUID(),
      mode: "create",
      input: createDefaultSessionInput(configSnapshot.data.groups[0]?.id),
    });
  }

  function editSession(id = activeSessionId) {
    const config = configSnapshot?.data.sessions.find((session) => session.id === id);
    if (!config) return;
    sessionCreatedCallbackRef.current = null;
    openSessionModal({ requestId: crypto.randomUUID(), mode: "edit", sessionId: id, input: sessionConfigToInput(config) });
  }

  async function saveSessionConfig(input: SessionInput) {
    const request = sessionModalRef.current;
    if (!configSnapshot || !request) return;
    const namedInput = {
      ...input,
      name: input.name.trim() || createNextSessionName(configSnapshot.data.sessions, request.mode === "edit" ? request.sessionId : undefined),
    };
    if (request.mode === "create") {
      const onCreated = sessionCreatedCallbackRef.current;
      const snapshot = await vaultApi.sessionCreate(namedInput);
      if (!mountedRef.current || sessionModalRef.current?.requestId !== request.requestId) return;
      const createdId = snapshot.data.sessions[snapshot.data.sessions.length - 1]?.id;
      applySnapshot(snapshot);
      closeSessionConfigModal();
      if (createdId) onCreated?.(createdId);
      return;
    } else {
      const snapshot = await vaultApi.sessionUpdate(request.sessionId, namedInput);
      if (!mountedRef.current || sessionModalRef.current?.requestId !== request.requestId) return;
      applySnapshot(snapshot);
    }
    closeSessionConfigModal();
  }

  function closeSessionConfigModal() {
    sessionCreatedCallbackRef.current = null;
    sessionModalRef.current = null;
    setSessionModal(null);
  }

  function openSessionModal(next: SessionModalState) {
    sessionModalRef.current = next;
    setSessionModal(next);
  }

  return {
    sessionModal,
    addSession,
    editSession,
    saveSessionConfig,
    closeSessionConfigModal,
  };
}
