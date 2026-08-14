import { useRef, type MutableRefObject } from "react";
import type { Dispatch, SetStateAction } from "react";
import { remoteApi } from "../api/remoteApi";
import { extractPromptCwd, shouldSkipTerminalEntry, stripCwdMarkers } from "./appHelpers";
import { getErrorMessage } from "../lib/configMapping";
import { normalizePath as normalizeRemotePath } from "../lib/path";
import { useMountedRef } from "../lib/reactLifecycle";
import { createTerminalEntry } from "../lib/session";
import {
  clearAllTerminalDirect,
  clearTerminalDirect,
  forgetTerminalDirect,
  writeTerminalEntryDirect,
} from "../lib/terminalRegistry";
import type { RemoteSession, TerminalClosedEvent, TerminalEntry, TerminalOutputEvent } from "../types";

type UseTerminalRuntimeOptions = {
  sessionsRef: MutableRefObject<RemoteSession[]>;
  setSessions: Dispatch<SetStateAction<RemoteSession[]>>;
  updateSession: (sessionId: string, updater: (session: RemoteSession) => RemoteSession) => void;
  setSessionFilesLoading: (sessionId: string, loading: boolean) => void;
  listFiles: (sftpId: string, path: string) => Promise<RemoteSession["files"]>;
  formatSessionError: (error: unknown, session: Pick<RemoteSession, "name" | "connectionId" | "terminalId" | "sftpId">) => string;
};

export function useTerminalRuntime({
  sessionsRef,
  setSessions,
  updateSession,
  setSessionFilesLoading,
  listFiles,
  formatSessionError,
}: UseTerminalRuntimeOptions) {
  const terminalSessionMapRef = useRef<Map<string, string>>(new Map());
  const mountedRef = useMountedRef();

  function registerTerminal(terminalId: string, sessionId: string) {
    terminalSessionMapRef.current.set(terminalId, sessionId);
  }

  function appendTerminal(sessionId: string, kind: TerminalOutputEvent["kind"] | "input", content: string) {
    const entry = createTerminalEntry(kind, content);
    if (!entry.content) return;
    updateSession(sessionId, (session) => ({
      ...session,
      terminal: shouldSkipTerminalEntry(session.terminal, entry) ? session.terminal : [...session.terminal, entry],
    }));
  }

  function handleTerminalOutput(payload: TerminalOutputEvent) {
    const { data: dataForPath, cwd } = stripCwdMarkers(payload.data);
    const promptCwd = extractTerminalPromptCwd(payload.terminalId, dataForPath);
    if (cwd || promptCwd) updateTerminalCwd(payload.terminalId, cwd ?? promptCwd ?? "");
    if (!payload.data) return;
    writeTerminalEntryDirect(payload.terminalId, createTerminalOutputEntry(payload, payload.data));
  }

  function createTerminalOutputEntry(payload: TerminalOutputEvent, content: string): TerminalEntry {
    return {
      ...createTerminalEntry(payload.kind, content),
      dataBase64: content === payload.data ? payload.dataBase64 : undefined,
    };
  }

  function extractTerminalPromptCwd(terminalId: string, data: string) {
    const session = sessionsRef.current.find((item) => item.terminalId === terminalId);
    if (!session) return null;
    return extractPromptCwd(data, session.username, session.loginPath);
  }

  function resetTerminalRuntime() {
    terminalSessionMapRef.current.clear();
    clearAllTerminalDirect();
  }

  function handleTerminalClosed(payload: TerminalClosedEvent) {
    const sessionId = terminalSessionMapRef.current.get(payload.terminalId);
    if (sessionId) {
      writeTerminalEntryDirect(
        payload.terminalId,
        createTerminalEntry("system", "终端通道已关闭"),
      );
    }
    terminalSessionMapRef.current.delete(payload.terminalId);
    forgetTerminalDirect(payload.terminalId);
    setSessions((current) => {
      let changed = false;
      const next = current.map((session) => {
        if (session.terminalId !== payload.terminalId) return session;
        changed = true;
        return {
          ...session,
          terminalId: null,
          connectionNotice: session.state === "connected"
            ? "终端通道已关闭；SSH 仍保持连接，可新开终端继续操作"
            : session.connectionNotice,
        };
      });
      return changed ? next : current;
    });
  }

  function updateTerminalCwd(terminalId: string, cwd: string) {
    const rawPath = cwd.trim();
    if (!rawPath.startsWith("/") || rawPath.includes("\n") || rawPath.includes("\r")) return;
    const nextPath = normalizeRemotePath(rawPath);
    const session = sessionsRef.current.find((item) => item.terminalId === terminalId);
    if (!session || session.currentPath === nextPath) return;
    updateSession(session.id, (item) => ({ ...item, currentPath: nextPath }));
    if (!session.sftpId) return;
    const requestSftpId = session.sftpId;
    setSessionFilesLoading(session.id, true);
    void listFiles(requestSftpId, nextPath)
      .then((files) => {
        if (!mountedRef.current) return;
        setSessions((current) =>
          current.map((item) =>
            item.id === session.id
              && item.sftpId === requestSftpId
              && normalizeRemotePath(item.currentPath) === nextPath
              ? { ...item, filesPath: nextPath, files }
              : item,
          ),
        );
      })
      .catch((error) => {
        if (mountedRef.current) {
          console.warn("[helm] failed to refresh files after terminal cwd change:", getErrorMessage(error));
        }
      })
      .finally(() => {
        if (mountedRef.current) setSessionFilesLoading(session.id, false);
      });
  }

  async function sendTerminalData(sessionId: string, terminalId: string | null | undefined, data: string) {
    if (!terminalId) return;
    try {
      await remoteApi.writeTerminal(terminalId, data);
    } catch (error) {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      appendTerminal(sessionId, "error", session ? formatSessionError(error, session) : getErrorMessage(error));
    }
  }

  async function sendTerminalCommand(sessionId: string, terminalId: string | null | undefined, command: string) {
    const trimmed = command.trim();
    if (!trimmed) return;
    await sendTerminalData(sessionId, terminalId, `${trimmed}\r`);
  }

  async function resizeTerminal(terminalId: string | null | undefined, cols: number, rows: number) {
    if (!terminalId) return;
    try {
      await remoteApi.resizeTerminal(terminalId, cols, rows);
    } catch (error) {
      console.debug("[helm] failed to resize terminal:", getErrorMessage(error));
    }
  }

  function clearTerminal(sessionId: string) {
    const terminalId = sessionsRef.current.find((session) => session.id === sessionId)?.terminalId;
    if (terminalId) clearTerminalDirect(terminalId);
    updateSession(sessionId, (session) => ({ ...session, terminal: [] }));
  }

  return {
    registerTerminal,
    appendTerminal,
    resetTerminalRuntime,
    handleTerminalOutput,
    handleTerminalClosed,
    sendTerminalData,
    sendTerminalCommand,
    resizeTerminal,
    clearTerminal,
  };
}
