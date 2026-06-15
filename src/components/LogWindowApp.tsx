import { CheckOutlined, CloseOutlined, CopyOutlined } from "@ant-design/icons";
import { Button, ConfigProvider, Empty, Tooltip, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useRef, useState } from "react";
import { appApi, type ApiLogEntry } from "../api/appApi";
import { appEvents } from "../api/appEvents";
import { writeClipboardText } from "../lib/clipboard";
import { getErrorMessage } from "../lib/configMapping";
import { formatBeijingMonthDayTime } from "../lib/format";
import { useMountedRef, useTimeoutRegistry } from "../lib/reactLifecycle";

export function LogWindowApp() {
  const [logs, setLogs] = useState<ApiLogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [detailCopied, setDetailCopied] = useState(false);
  const [selectedLog, setSelectedLog] = useState<ApiLogEntry | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mountedRef = useMountedRef();
  const setSafeTimeout = useTimeoutRegistry();

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;
    let pollingTimer: number | null = null;
    const load = () => {
      void appApi.apiServerLogs()
        .then((items) => {
          if (mounted) setLogs(items);
        })
        .catch((error) => {
          console.warn("[helm] failed to load api logs:", getErrorMessage(error));
        });
    };
    load();
    void appEvents.onApiLog((entry) => {
      if (!mounted) return;
      if (pollingTimer !== null) { clearInterval(pollingTimer); pollingTimer = null; }
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
    }).then((u) => {
      if (!mounted) { u(); return; }
      unlisten = u;
      pollingTimer = window.setInterval(load, 5000);
    }).catch((error) => {
      console.warn("[helm] failed to subscribe api logs:", getErrorMessage(error));
      if (mounted) pollingTimer = window.setInterval(load, 3000);
    });
    return () => {
      mounted = false;
      if (unlisten) unlisten();
      if (pollingTimer !== null) clearInterval(pollingTimer);
    };
  }, []);

  const reversed = [...logs].reverse();

  async function copyLogs() {
    if (logs.length === 0) return;
    const text = reversed.map((log) => {
      const lines = [
        `[${formatLogTime(log.timestamp)}] ${log.success ? "OK" : "ERR"} ${log.action} | ${log.detail} (${log.durationMs}ms)`,
        ...(log.response ? [log.response] : []),
      ];
      return lines.join("\n");
    }).join("\n\n");
    if (!(await writeClipboardText(text))) return;
    if (!mountedRef.current) return;
    setCopied(true);
    setSafeTimeout(() => setCopied(false), 2000);
  }

  async function copySingleLog(log: ApiLogEntry) {
    if (!(await writeClipboardText(formatLogDetail(log)))) return;
    if (!mountedRef.current) return;
    setCopiedKey(logKey(log));
    setSafeTimeout(() => setCopiedKey(null), 1500);
  }

  async function copySelectedLog(log: ApiLogEntry) {
    if (!(await writeClipboardText(formatLogDetail(log)))) return;
    if (!mountedRef.current) return;
    setDetailCopied(true);
    setSafeTimeout(() => setDetailCopied(false), 1500);
  }

  function handleClick(log: ApiLogEntry) {
    setSelectedLog(log);
  }

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm }}>
      <div className="logWindow">
        <header className="logWindowHeader">
          <span className="logWindowTitle">操作日志</span>
          <div className="logWindowHeaderRight">
            <span className="logWindowCount">{logs.length} 条记录</span>
            <Tooltip title={copied ? "已复制" : "复制日志"}>
              <Button
                size="small"
                type="text"
                icon={copied ? <CheckOutlined style={{ color: "#10b981" }} /> : <CopyOutlined />}
                disabled={logs.length === 0}
                onClick={() => void copyLogs()}
              />
            </Tooltip>
          </div>
        </header>
        <div className="logWindowBody" ref={listRef} style={{ position: "relative" }}>
          {reversed.length === 0 ? (
            <div className="logWindowEmpty">
              <Empty description="暂无日志" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          ) : (
            <div className="logWindowList">
              {reversed.map((log) => {
                const key = logKey(log);
                return (
                <div
                  key={key}
                  className={`aiApiLogItem aiApiLogItem-${log.success ? "ok" : "err"}`}
                  onClick={() => handleClick(log)}
                  style={{ cursor: "pointer" }}
                >
                  <span className="aiApiLogTime">{formatLogTime(log.timestamp)}</span>
                  <span className={`aiApiLogAction aiApiLogAction-${log.action}`}>{log.action.toUpperCase()}</span>
                  <span className="aiApiLogDetail">{log.detail}</span>
                  <span className="aiApiLogDuration">{log.durationMs}ms</span>
                  <span
                    className={`aiApiLogCopy${copiedKey === key ? " aiApiLogCopy-done" : ""}`}
                    role="button"
                    tabIndex={0}
                    title="复制此条"
                    onClick={(e) => { e.stopPropagation(); void copySingleLog(log); }}
                    onKeyDown={(e) => { if (e.key === "Enter") void copySingleLog(log); }}
                  >
                    {copiedKey === key ? <CheckOutlined /> : <CopyOutlined />}
                  </span>
                </div>
                );
              })}
            </div>
          )}
          {selectedLog && (
            <div className="logDetailModal-overlay" onClick={() => { setSelectedLog(null); setDetailCopied(false); }}>
              <div className="logDetailModal" onClick={(e) => e.stopPropagation()}>
                <div className="logDetailModalHeader">
                  <span className="logDetailModalTitle">日志详情</span>
                  <span
                    className="logDetailModalClose"
                    role="button"
                    tabIndex={0}
                    title="关闭"
                    onClick={() => { setSelectedLog(null); setDetailCopied(false); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { setSelectedLog(null); setDetailCopied(false); } }}
                  >
                    <CloseOutlined />
                  </span>
                </div>
                <div className="logDetailSection">
                  <div className="logDetailLabelRow">
                    <span className="logDetailLabel">命令</span>
                    <span
                      className={`aiApiLogCopy${detailCopied ? " aiApiLogCopy-done" : ""}`}
                      role="button"
                      tabIndex={0}
                      title="复制此条"
                      style={{ opacity: 1 }}
                      onClick={() => void copySelectedLog(selectedLog)}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.click(); }}
                    >
                      {detailCopied ? <CheckOutlined /> : <CopyOutlined />}
                    </span>
                  </div>
                  <pre className="logDetailCommand">{selectedLog.detail}</pre>
                </div>
                {selectedLog.response && (
                  <div className="logDetailSection">
                    <span className="logDetailLabel">响应</span>
                    <pre className="logDetailResponse">{selectedLog.response}</pre>
                  </div>
                )}
                <div className="logDetailMeta">
                  <span>{formatLogTime(selectedLog.timestamp)}</span>
                  <span>{selectedLog.durationMs}ms</span>
                  <span className={selectedLog.success ? "logDetailMetaOk" : "logDetailMetaErr"}>
                    {selectedLog.success ? "成功" : "失败"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </ConfigProvider>
  );
}

function formatLogTime(timestamp: string): string {
  return formatBeijingMonthDayTime(timestamp, timestamp, true);
}

function formatLogDetail(log: ApiLogEntry) {
  return [
    `时间: ${formatLogTime(log.timestamp)}`,
    `状态: ${log.success ? "成功" : "失败"}`,
    `类型: ${log.action}`,
    `命令: ${log.detail}`,
    `耗时: ${log.durationMs}ms`,
    ...(log.response ? [`\n--- 响应 ---\n${log.response}`] : []),
  ].join("\n");
}

function logKey(log: ApiLogEntry) {
  return `${log.timestamp}|${log.action}|${log.durationMs}|${log.success ? 1 : 0}|${log.detail}`;
}
