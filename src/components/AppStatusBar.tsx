import { CodeOutlined, FolderOpenOutlined, LinkOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useState } from "react";
import { formatElapsedSince } from "../lib/duration";
import type { RemoteSession } from "../types";

interface AppStatusBarProps {
  activeSession?: RemoteSession;
  sessions: RemoteSession[];
  connectingSessionId: string | null;
}

export function AppStatusBar({ activeSession, sessions, connectingSessionId }: AppStatusBarProps) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const connectedSessions = useMemo(() => sessions.filter((session) => session.state === "connected"), [sessions]);
  const terminalCount = sessions.filter((session) => session.terminalId).length;
  const connected = activeSession?.state === "connected";
  const connecting = Boolean(activeSession && connectingSessionId === activeSession.id);
  const activeHost = activeSession?.host ?? "";
  const statusText = connected
    ? `已连接 ${activeHost}`
    : connecting
      ? `连接中 ${activeHost}`
      : connectedSessions.length > 0
        ? `已连接 ${connectedSessions.length} 个会话`
        : "未连接";
  const sshDuration = connected ? formatElapsedSince(activeSession?.connectedAt, now) : "-";
  const sftpText = connected ? (activeSession?.sftpId ? "SFTP 就绪" : "SFTP 未打开") : "SFTP 离线";

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleCopy = () => {
    if (!activeHost) return;
    navigator.clipboard.writeText(activeHost).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch((err) => {
      console.error("Failed to copy host:", err);
    });
  };

  return (
    <footer className="appStatusBar">
      {/* 科技感声纳雷达连接标签 */}
      <div 
        className={`status-radar-capsule radar-${connected ? "connected" : connecting ? "connecting" : "offline"} ${connected ? "clickable" : ""}`}
        onClick={connected ? handleCopy : undefined}
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
      
      {/* 状态芯片控制组 */}
      <div className="appStatusBarGroup">
        <div className={`status-chip chip-ssh ${connected ? "active" : ""}`} title={connected ? `SSH 连接时长：${sshDuration}` : "SSH 未连接"}>
          <span className="chip-led" />
          <LinkOutlined />
          <span className="chip-label">SSH</span>
          <span className="chip-value">{sshDuration}</span>
        </div>
        <div className="status-chip chip-terminal" title={`活动终端：${terminalCount} 个`}>
          <span className="chip-led" />
          <CodeOutlined />
          <span className="chip-label">TERM</span>
          <span className="chip-value">{terminalCount}</span>
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
