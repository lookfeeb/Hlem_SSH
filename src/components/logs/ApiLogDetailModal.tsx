import { CheckCircleFilled, CheckOutlined, ClockCircleOutlined, CloseCircleFilled, CodeOutlined, CopyOutlined, CalendarOutlined } from "@ant-design/icons";
import { Button, Modal, Segmented } from "antd";
import { useMemo, useState } from "react";
import type { ApiLogEntry } from "../../api/appApi";
import { apiLogEntryKey, extractApiLogOutputs, formatApiLogResponse } from "../../lib/apiLogEntries";
import { writeClipboardText } from "../../lib/clipboard";
import { formatBeijingMonthDayTime } from "../../lib/format";
import { useMountedRef, useTimeoutRegistry } from "../../lib/reactLifecycle";

export function ApiLogTypeBadge({ action }: { action: string }) {
  const kind = action.split("/").pop()?.split(".")[0] ?? "";
  const tone = kind === "upload" ? "green" : kind === "download" ? "purple" : kind === "files" ? "amber" : "blue";
  return <span className={`logTypeBadge logTypeBadge-${tone}`} title={action.toUpperCase()}>{action.toUpperCase()}</span>;
}

export function ApiLogStatus({ success, detailed = false }: { success: boolean; detailed?: boolean }) {
  return <span className={`logStatus ${success ? "is-success" : "is-error"}`}>{detailed ? (success ? <CheckCircleFilled /> : <CloseCircleFilled />) : <i />}{success ? "成功" : "失败"}</span>;
}

export function formatApiLogDetail(log: ApiLogEntry) {
  return [
    `时间: ${formatBeijingMonthDayTime(log.timestamp, log.timestamp, true)}`,
    `状态: ${log.success ? "成功" : "失败"}`,
    `类型: ${log.action}`,
    `命令: ${log.detail}`,
    `耗时: ${log.durationMs}ms`,
    ...(log.response ? [`\n--- 响应 ---\n${log.response}`] : []),
  ].join("\n");
}

function LogCodeBlock({ text, response = false, outputLabel }: { text: string; response?: boolean; outputLabel?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const mountedRef = useMountedRef();
  const setSafeTimeout = useTimeoutRegistry();
  const formatted = useMemo(() => response && !outputLabel ? formatApiLogResponse(text) : text, [text, response, outputLabel]);
  const content = useMemo(() => {
    if (!response || outputLabel || formatted.length > 128 * 1024 || (formatted === text && !/^\s*[\[{]/.test(text))) return formatted;
    // React text nodes keep command output inert, including HTML-like strings.
    return formatted.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g).map((token, index) => {
      const kind = token.startsWith('"') ? (token.trimEnd().endsWith(":") ? "key" : "string") : /^(true|false|null)$/.test(token) ? "literal" : /^-?\d/.test(token) ? "number" : "plain";
      return <span key={index} className={`logSyntax-${kind}`}>{token}</span>;
    });
  }, [formatted, text, response, outputLabel]);

  async function copy() {
    const success = await writeClipboardText(text);
    if (!mountedRef.current) return;
    setCopyState(success ? "copied" : "error");
    setSafeTimeout(() => setCopyState("idle"), 1800);
  }

  return <div className={`logCodeBlock ${response ? "is-response" : "is-command"}`}>
    <div className="logCodeToolbar"><span>{outputLabel ?? (response ? "RESPONSE" : "COMMAND")}</span><Button type="text" size="small" disabled={!text} aria-label={outputLabel ? `复制${outputLabel}` : response ? "复制响应" : "复制命令"} icon={copyState === "copied" ? <CheckOutlined /> : <CopyOutlined />} onClick={() => void copy()}>{copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : "复制"}</Button></div>
    <pre tabIndex={0} aria-label={outputLabel ?? (response ? "响应内容" : "命令内容")}>{content || (outputLabel ? "（空输出）" : response ? "此条日志未记录响应内容" : "此条日志未记录命令内容")}</pre>
  </div>;
}

export function ApiLogDetailModal({ log, onClose }: { log: ApiLogEntry | null; onClose: () => void }) {
  return <Modal open={Boolean(log)} title={<div className="logDetailTitle"><span>日志详情</span>{log && <CopyLogButton key={apiLogEntryKey(log)} log={log} />}</div>} footer={null} onCancel={onClose} width={660} centered destroyOnHidden className="logDetailModal" classNames={{ mask: "logDetailMask" }}>
    {log && <div className="logDetailBody" key={apiLogEntryKey(log)}>
      <section className="logDetailSection" aria-labelledby="logBasicHeading">
        <h2 id="logBasicHeading">基本信息</h2>
        <dl className="logDetailFacts">
          <div><dt><CalendarOutlined />时间</dt><dd>{formatBeijingMonthDayTime(log.timestamp, log.timestamp, true)}</dd></div>
          <div><dt><CodeOutlined />类型</dt><dd><ApiLogTypeBadge action={log.action} /></dd></div>
          <div><dt>{log.success ? <CheckCircleFilled /> : <CloseCircleFilled />}状态</dt><dd><ApiLogStatus success={log.success} detailed /></dd></div>
          <div><dt><ClockCircleOutlined />耗时</dt><dd>{log.durationMs}<span className="logDetailUnit">ms</span></dd></div>
        </dl>
      </section>
      <section className="logDetailSection" aria-labelledby="logCommandHeading"><h2 id="logCommandHeading">命令 / 操作</h2><LogCodeBlock text={log.detail} /></section>
      <LogResponse text={log.response ?? ""} />
    </div>}
  </Modal>;
}

function LogResponse({ text }: { text: string }) {
  const outputs = useMemo(() => extractApiLogOutputs(text), [text]);
  const [mode, setMode] = useState("output");
  const showOutputs = outputs.length > 0 && mode === "output";
  return <section className="logDetailSection" aria-labelledby="logResponseHeading">
    <div className="logResponseHeading"><h2 id="logResponseHeading">响应</h2>{outputs.length > 0 && <Segmented size="small" aria-label="响应显示方式" value={mode} onChange={setMode} options={[{ label: "文本输出", value: "output" }, { label: "JSON", value: "json" }]} />}</div>
    {showOutputs ? <div className="logResponseOutputs">{outputs.map((output, index) => <LogCodeBlock key={index} text={output.text} response outputLabel={output.label} />)}</div> : <LogCodeBlock key="json" text={text} response />}
  </section>;
}

function CopyLogButton({ log }: { log: ApiLogEntry }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const mountedRef = useMountedRef();
  const setSafeTimeout = useTimeoutRegistry();
  async function copy() {
    const success = await writeClipboardText(formatApiLogDetail(log));
    if (!mountedRef.current) return;
    setState(success ? "copied" : "error");
    setSafeTimeout(() => setState("idle"), 1800);
  }
  return <Button type="text" size="small" aria-label="复制此条日志" icon={state === "copied" ? <CheckOutlined /> : <CopyOutlined />} onClick={() => void copy()}>{state === "copied" ? "已复制" : state === "error" ? "复制失败" : "复制此条"}</Button>;
}
