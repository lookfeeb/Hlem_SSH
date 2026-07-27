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
  const sessionCreatedCallbackRef = useRef<((sessionId: string) => void) | null>(null);

  function addSession(onCreated?: (sessionId: string) => void) {
    if (!configSnapshot) return;
    sessionCreatedCallbackRef.current = onCreated ?? null;
    setSessionModal({
      mode: "create",
      input: createDefaultSessionInput(configSnapshot.data.groups[0]?.id),
    });
  }

  function editSession(id = activeSessionId) {
    const config = configSnapshot?.data.sessions.find((session) => session.id === id);
    if (!config) return;
    sessionCreatedCallbackRef.current = null;
    setSessionModal({ mode: "edit", sessionId: id, input: sessionConfigToInput(config) });
  }

  async function saveSessionConfig(input: SessionInput) {
    if (!configSnapshot || !sessionModal) return;
    const namedInput = {
      ...input,
      name: input.name.trim() || createNextSessionName(configSnapshot.data.sessions, sessionModal.mode === "edit" ? sessionModal.sessionId : undefined),
    };
    if (sessionModal.mode === "create") {
      const onCreated = sessionCreatedCallbackRef.current;
      const snapshot = await vaultApi.sessionCreate(namedInput);
      if (!mountedRef.current) return;
      const createdId = snapshot.data.sessions[snapshot.data.sessions.length - 1]?.id;
      applySnapshot(snapshot, createdId);
      closeSessionConfigModal();
      if (createdId) onCreated?.(createdId);
      return;
    } else {
      const snapshot = await vaultApi.sessionUpdate(sessionModal.sessionId, namedInput);
      if (!mountedRef.current) return;
      applySnapshot(snapshot, sessionModal.sessionId);
    }
    closeSessionConfigModal();
  }

  function closeSessionConfigModal() {
    sessionCreatedCallbackRef.current = null;
    setSessionModal(null);
  }

  return {
    sessionModal,
    addSession,
    editSession,
    saveSessionConfig,
    closeSessionConfigModal,
  };
}
