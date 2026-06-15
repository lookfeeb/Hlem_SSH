import { CodeOutlined, FolderOpenOutlined, LinkOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useState } from "react";
import { writeClipboardText } from "../lib/clipboard";
import { formatElapsedSince } from "../lib/duration";
import { useMountedRef, useTimeoutRegistry } from "../lib/reactLifecycle";
import type { RemoteSession } from "../types";

interface AppStatusBarProps {
  activeSession?: RemoteSession;
  sessions: RemoteSession[];
  connectingSessionId: string | null;
}

export function AppStatusBar({ activeSession, sessions, connectingSessionId }: AppStatusBarProps) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const mountedRef = useMountedRef();
  const setSafeTimeout = useTimeoutRegistry();
  const sessionStats = useMemo(
    () =>
      sessions.reduce(
        (stats, session) => ({
          connectedCount: stats.connectedCount + (session.state === "connected" ? 1 : 0),
          terminalCount: stats.terminalCount + (session.terminalId ? 1 : 0),
        }),
        { connectedCount: 0, terminalCount: 0 },
      ),
    [sessions],
  );
  const connected = activeSession?.state === "connected";
  const connecting = Boolean(activeSession && connectingSessionId === activeSession.id);
  const activeHost = activeSession?.host ?? "";
  const statusText = connected
    ? `已连接 ${activeHost}`
    : connecting
      ? `连接中 ${activeHost}`
      : sessionStats.connectedCount > 0
        ? `已连接 ${sessionStats.connectedCount} 个会话`
        : "未连接";
  const sshDuration = connected ? formatElapsedSince(activeSession?.connectedAt, now) : "-";
  const sftpText = connected ? (activeSession?.sftpId ? "SFTP 就绪" : "SFTP 未打开") : "SFTP 离线";

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleCopy = async () => {
    if (!activeHost) return;
    if (!(await writeClipboardText(activeHost))) return;
    if (!mountedRef.current) return;
    setCopied(true);
    setSafeTimeout(() => setCopied(false), 1500);
  };

  return (
    <footer className="appStatusBar">
      <div 
        className={`status-radar-capsule radar-${connected ? "connected" : connecting ? "connecting" : "offline"} ${connected ? "clickable" : ""}`}
        onClick={connected ? () => void handleCopy() : undefined}
        title={connected ? "点击复制 IP 地址" : undefined}
      >
        <div className="radar-wave">
          <span className="radar-dot" />
          {connected && <span className="radar-ring" />}
        </div>
        <span className="status-host-tag" title={statusText}>
          {copied ? "COPIED" : connected ? activeHost : connecting ? activeHost : "DISCONNECTED"}
        </span>
      </div>
      <div className="appStatusBarGroup">
        <div className={`status-chip chip-ssh ${connected ? "active" : ""}`} title={connected ? `SSH 连接时长：${sshDuration}` : "SSH 未连接"}>
          <span className="chip-led" />
          <LinkOutlined />
          <span className="chip-label">SSH</span>
          <span className="chip-value">{sshDuration}</span>
        </div>
        <div className="status-chip chip-terminal" title={`活动终端：${sessionStats.terminalCount} 个`}>
          <span className="chip-led" />
          <CodeOutlined />
          <span className="chip-label">TERM</span>
          <span className="chip-value">{sessionStats.terminalCount}</span>
        </div>
        <div className={`status-chip chip-sftp ${connected && activeSession?.sftpId ? "active" : ""}`} title={sftpText}>
          <span className="chip-led" />
          <FolderOpenOutlined />
          <span className="chip-value">{sftpText}</span>
        </div>
      </div>
    </footer>
  );
}
