import { memo, useLayoutEffect, useRef, type RefObject } from "react";
import type { RemoteDownloadSelection } from "../app/remoteDownloadPlan";
import type { QuickCommand, RemoteFileEntry, RemoteSession } from "../types";
import { FileManager, type FileOperation } from "./FileManager";
import { SplitPane } from "./SplitPane";
import { TelemetrySidebar, type TelemetrySidebarHandle } from "./TelemetrySidebar";
import { TerminalPanel } from "./TerminalPanel";

export interface SessionWorkspaceActions {
  sendTerminalData: (sessionId: string, terminalId: string | null | undefined, data: string) => Promise<void>;
  sendTerminalCommand: (sessionId: string, terminalId: string | null | undefined, command: string) => Promise<void>;
  resizeTerminal: (terminalId: string | null | undefined, cols: number, rows: number) => Promise<void>;
  clearTerminal: (sessionId: string) => void;
  changePath: (sessionId: string, path: string) => Promise<void>;
  refreshSessionFiles: (sessionId: string) => Promise<void>;
  searchRemoteFile: (sessionId: string, query: string) => Promise<string | null>;
  listRemoteDirectory: (sessionId: string, path: string) => Promise<RemoteFileEntry[]>;
  runFileOperation: (sessionId: string, operation: FileOperation) => Promise<void>;
  uploadLocalFiles: (sessionId: string, localPaths: string[], targetDirectory: string) => Promise<void>;
  downloadRemoteFiles: (sessionId: string, files: RemoteDownloadSelection[]) => Promise<void>;
  readRemoteText: (path: string, sessionId?: string) => Promise<string>;
  writeRemoteText: (path: string, content: string, sessionId?: string) => Promise<void>;
  saveQuickCommands: (commands: QuickCommand[]) => Promise<void>;
}

interface SessionWorkspaceProps {
  session: RemoteSession;
  active: boolean;
  filesLoading: boolean;
  quickCommands: QuickCommand[];
  scrollback: number;
  webglEnabled: boolean;
  actionsRef: RefObject<SessionWorkspaceActions | null>;
}

function SessionWorkspaceView({
  session,
  active,
  filesLoading,
  quickCommands,
  scrollback,
  webglEnabled,
  actionsRef,
}: SessionWorkspaceProps) {
  const telemetryRef = useRef<TelemetrySidebarHandle>(null);
  const actions = () => {
    const current = actionsRef.current;
    if (!current) throw new Error("会话工作区尚未初始化");
    return current;
  };

  useLayoutEffect(() => {
    telemetryRef.current?.setActive(active);
  }, [active]);

  return (
    <div
      className={`sessionWorkspaceSlot${active ? " sessionWorkspaceSlot-active" : ""}`}
      aria-hidden={!active}
      inert={!active}
    >
      <section className="mainSurface">
        <SplitPane
          minTop={240}
          minBottom={220}
          top={
            <TerminalPanel
              session={session}
              active={active}
              scrollback={scrollback}
              webglEnabled={webglEnabled}
              onSendData={(data) => void actions().sendTerminalData(session.id, session.terminalId, data)}
              onResize={(cols, rows) => void actions().resizeTerminal(session.terminalId, cols, rows)}
              onClear={() => actions().clearTerminal(session.id)}
            />
          }
          bottom={
            <FileManager
              session={session}
              active={active}
              onPathChange={(path) => void actions().changePath(session.id, path)}
              onRefresh={() => actions().refreshSessionFiles(session.id)}
              onRemoteSearch={(query) => actions().searchRemoteFile(session.id, query)}
              onListDirectory={(path) => actions().listRemoteDirectory(session.id, path)}
              onFileOperation={(operation) => actions().runFileOperation(session.id, operation)}
              onUploadFiles={(paths, targetDirectory) => actions().uploadLocalFiles(session.id, paths, targetDirectory)}
              onDownloadFiles={(files) => actions().downloadRemoteFiles(session.id, files)}
              onReadText={(path, sessionId) => actions().readRemoteText(path, sessionId ?? session.id)}
              onWriteText={(path, content, sessionId) => actions().writeRemoteText(path, content, sessionId ?? session.id)}
              onSendCommand={(command) => actions().sendTerminalCommand(session.id, session.terminalId, command)}
              quickCommands={quickCommands}
              onQuickCommandsChange={(commands) => actions().saveQuickCommands(commands)}
              filesLoading={filesLoading}
            />
          }
        />
      </section>
      <TelemetrySidebar ref={telemetryRef} session={session} />
    </div>
  );
}

export const SessionWorkspace = memo(SessionWorkspaceView);
