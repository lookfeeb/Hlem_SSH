import { CheckOutlined, CopyOutlined, FundProjectionScreenOutlined, MinusOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Input, InputNumber, Modal, Select, Switch, Tooltip, message } from "antd";
import type { MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, ConfigSnapshot } from "../../types";
import { appApi, type ApiServerInfo, type ApiLogEntry } from "../../api/appApi";
import { appEvents } from "../../api/appEvents";
import { vaultApi } from "../../api/vaultApi";
import { writeClipboardText } from "../../lib/clipboard";
import { getErrorMessage } from "../../lib/configMapping";
import { useMountedRef, useTimeoutRegistry } from "../../lib/reactLifecycle";

interface AiApiPanelProps {
  open: boolean;
  onClose: () => void;
  initialValue: AppSettings;
  sessions: { id: string; name: string; host: string }[];
  onApiServerChange: (running: boolean) => void;
  onSettingsChange: (snapshot: ConfigSnapshot) => void;
}

const MAX_AI_API_SESSIONS = 5;

function compactAiApiSessionRows(rows: Array<string | null | undefined>) {
  const ids: string[] = [];
  for (const row of rows) {
    if (!row || ids.includes(row)) continue;
    ids.push(row);
    if (ids.length >= MAX_AI_API_SESSIONS) break;
  }
  return ids;
}

function initialAiApiSessionRows(settings: AppSettings, sessions: { id: string }[]) {
  const availableIds = new Set(sessions.map((session) => session.id));
  const ids = compactAiApiSessionRows([...(settings.aiApiSessionIds ?? []), settings.aiApiSessionId])
    .filter((id) => availableIds.has(id));
  return ids.length > 0 ? ids : [null];
}

function normalizeAiApiSessionRows(rows: Array<string | null>) {
  const seen = new Set<string>();
  return rows.slice(0, MAX_AI_API_SESSIONS).map((row) => {
    if (!row || seen.has(row)) return null;
    seen.add(row);
    return row;
  });
}

function sameSessionIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function AiApiPanel({ open, onClose, initialValue, sessions, onApiServerChange, onSettingsChange }: AiApiPanelProps) {
  const [aiApiInfo, setAiApiInfo] = useState<ApiServerInfo | null>(null);
  const [aiApiLoading, setAiApiLoading] = useState(false);
  const [aiApiPort, setAiApiPort] = useState(() => initialValue.aiApiPort ?? 19880);
  const [aiApiAutoStart, setAiApiAutoStart] = useState(() => initialValue.aiApiAutoStart ?? false);
  const mountedRef = useMountedRef();
  const setSafeTimeout = useTimeoutRegistry();
  const autoStartPendingRef = useRef(false);
  const autoStartAttemptedRef = useRef(false);
  const [aiApiSessionRows, setAiApiSessionRows] = useState<Array<string | null>>(() => initialAiApiSessionRows(initialValue, sessions));
  const [aiApiLogs, setAiApiLogs] = useState<ApiLogEntry[]>([]);
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const availableAiApiSessionIdsKey = sessions.map((session) => session.id).join("|");
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const sessionOptions = useMemo(
    () => sessions.map((session) => ({ label: session.name, value: session.id })),
    [sessions],
  );
  const selectedAiApiSessionIds = useMemo(() => compactAiApiSessionRows(aiApiSessionRows), [aiApiSessionRows]);

  useEffect(() => {
    if (!open) return;
    autoStartAttemptedRef.current = false;
    setAiApiSessionRows(initialAiApiSessionRows(initialValue, sessions));
    setAiApiPort(initialValue.aiApiPort ?? 19880);
    setAiApiAutoStart(initialValue.aiApiAutoStart ?? false);
  }, [availableAiApiSessionIdsKey, open]);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    let unlisten: (() => void) | null = null;
    void appApi.apiServerLogs().then((items) => {
      if (mounted) setAiApiLogs(items);
    }).catch((error) => {
      console.warn("[helm] failed to load api logs:", getErrorMessage(error));
    });
    void refreshAiApiStatus();
    void appEvents.onApiLog((entry) => {
      if (!mounted) return;
      setAiApiLogs((prev) => {
        const next = [...prev, entry];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
    }).then((u) => {
      if (!mounted) { u(); return; }
      unlisten = u;
    }).catch((error) => {
      console.warn("[helm] failed to subscribe api logs:", getErrorMessage(error));
    });
    return () => { mounted = false; if (unlisten) unlisten(); };
  }, [open]);

  useEffect(() => {
    if (!open || autoStartAttemptedRef.current || autoStartPendingRef.current || aiApiLoading || aiApiInfo?.running || selectedAiApiSessionIds.length === 0) return;
    autoStartAttemptedRef.current = true;
    autoStartPendingRef.current = true;
    void startAiApi().finally(() => {
      autoStartPendingRef.current = false;
    });
  }, [aiApiInfo?.running, aiApiLoading, open, selectedAiApiSessionIds.join("|")]);

  async function refreshAiApiStatus() {
    try {
      const info = await appApi.apiServerStatus();
      if (!mountedRef.current) return;
      setAiApiInfo(info);
      onApiServerChange(info.running);
      if (info.running && info.port) setAiApiPort(info.port);
    } catch (error) {
      if (!mountedRef.current) return;
      console.warn("[helm] failed to refresh ai api status:", getErrorMessage(error));
      setAiApiInfo(null);
    }
  }

  async function startAiApi() {
    setAiApiLoading(true);
    try {
      const info = await appApi.apiServerStart(aiApiPort, selectedAiApiSessionIds);
      if (!mountedRef.current) return;
      setAiApiInfo(info);
      onApiServerChange(true);
      try {
        await persistAiApiSettings({
          aiApiKey: info.apiKey,
          aiApiPort: info.port || aiApiPort,
          aiApiSessionId: selectedAiApiSessionIds[0] ?? null,
          aiApiSessionIds: selectedAiApiSessionIds,
          aiApiAutoStart,
        });
      } catch (error) {
        if (mountedRef.current) message.warning(`API 已启动，但保存设置失败：${getErrorMessage(error)}`);
      }
    } catch (error) {
      if (mountedRef.current) Modal.error({ title: "启动 API 服务失败", content: getErrorMessage(error) });
    }
    finally { if (mountedRef.current) setAiApiLoading(false); }
  }

  async function stopAiApi() {
    autoStartAttemptedRef.current = true;
    setAiApiLoading(true);
    try {
      await appApi.apiServerStop();
      if (!mountedRef.current) return;
      setAiApiInfo((prev) => ({
        running: false,
        port: prev?.port ?? aiApiPort,
        apiKey: prev?.apiKey ?? initialValue.aiApiKey ?? "",
      }));
      onApiServerChange(false);
      message.success("AI API 已关闭");
    } catch (error) {
      if (mountedRef.current) Modal.error({ title: "关闭 API 服务失败", content: getErrorMessage(error) });
    }
    finally { if (mountedRef.current) setAiApiLoading(false); }
  }

  async function toggleAiApiStatus() {
    if (aiApiLoading) return;
    if (aiApiInfo?.running) {
      await stopAiApi();
      return;
    }
    autoStartAttemptedRef.current = true;
    await startAiApi();
  }

  function aiApiStatusTooltip() {
    if (aiApiLoading) return aiApiInfo?.running ? "正在关闭 API 服务" : "正在开启 API 服务";
    return aiApiInfo?.running ? "点击关闭 API 服务" : "点击开启 API 服务";
  }

  async function regenerateKey() {
    try {
      const info = await appApi.apiServerRegenerateKey();
      if (!mountedRef.current) return;
      setAiApiInfo(info);
      message.success("API Key 已重新生成");
    } catch (error) {
      if (mountedRef.current) Modal.error({ title: "重新生成密钥失败", content: getErrorMessage(error) });
    }
  }

  function addAiApiSessionRow() {
    setAiApiSessionRows((prev) => {
      if (prev.length >= MAX_AI_API_SESSIONS || prev.length >= sessions.length || !prev[prev.length - 1]) return prev;
      return [...prev, null];
    });
  }

  function addAiApiSessionTooltip(sessionId: string | null, isLastRow: boolean) {
    if (!isLastRow) return "";
    if (aiApiSessionRows.length >= MAX_AI_API_SESSIONS) return "最多指定 5 个会话";
    if (aiApiSessionRows.length >= sessions.length) return "没有更多可选会话";
    if (!sessionId) return "请先选择当前会话";
    return "添加指定会话";
  }

  function selectApiKeyInput(event: MouseEvent<HTMLInputElement>) {
    event.currentTarget.select();
  }

  async function changeAiApiSession(index: number, sessionId: string | null) {
    const previousRows = aiApiSessionRows;
    const nextRows = previousRows.map((row, rowIndex) => (rowIndex === index ? sessionId : row));
    await saveAiApiSessionRows(nextRows, previousRows);
  }

  async function removeAiApiSessionRow(index: number) {
    const previousRows = aiApiSessionRows;
    const nextRows = previousRows.length > 1 ? previousRows.filter((_, rowIndex) => rowIndex !== index) : [null];
    await saveAiApiSessionRows(nextRows, previousRows);
  }

  async function saveAiApiSessionRows(nextRowsInput: Array<string | null>, previousRows: Array<string | null>) {
    const nextRows = normalizeAiApiSessionRows(nextRowsInput);
    const previousSessionIds = compactAiApiSessionRows(previousRows);
    const nextSessionIds = compactAiApiSessionRows(nextRows);
    const previousAutoStart = aiApiAutoStart;
    const nextAutoStart = nextSessionIds.length > 0 ? aiApiAutoStart : false;

    setAiApiSessionRows(nextRows);
    if (!nextAutoStart) setAiApiAutoStart(false);
    try {
      await persistAiApiSettings({
        aiApiSessionId: nextSessionIds[0] ?? null,
        aiApiSessionIds: nextSessionIds,
        aiApiPort,
        aiApiAutoStart: nextAutoStart,
      });
      if (!mountedRef.current) return;
    } catch (error) {
      if (mountedRef.current) {
        message.error(`保存失败：${getErrorMessage(error)}`);
        setAiApiSessionRows(previousRows);
        setAiApiAutoStart(previousAutoStart);
      }
      return;
    }
    if (sameSessionIds(previousSessionIds, nextSessionIds)) return;
    if (aiApiInfo?.running) {
      try {
        const info = await appApi.apiServerUpdateSessions(nextSessionIds);
        if (!mountedRef.current) return;
        setAiApiInfo(info);
        onApiServerChange(info.running);
        if (info.running) {
          message.success(nextSessionIds.length > 0 ? "指定会话已更新" : "已清除会话限制，API 已热更新");
        } else {
          message.warning("API 服务已停止，仅保存会话配置");
        }
      } catch (error) {
        if (mountedRef.current) message.error(`热更新 API 会话失败：${getErrorMessage(error)}`);
      }
    } else {
      message.success(nextSessionIds.length > 0 ? "指定会话已更新" : "已清除会话限制");
    }
  }

  async function changeAiApiAutoStart(checked: boolean) {
    setAiApiAutoStart(checked);
    try {
      await persistAiApiSettings({
        aiApiAutoStart: checked,
        aiApiSessionId: selectedAiApiSessionIds[0] ?? null,
        aiApiSessionIds: selectedAiApiSessionIds,
        aiApiPort,
      });
      if (!mountedRef.current) return;
      message.success(checked ? "已开启随应用自动启动" : "已关闭自动启动");
    } catch (error) {
      if (mountedRef.current) {
        message.error(`保存失败：${getErrorMessage(error)}`);
        setAiApiAutoStart(!checked);
      }
    }
  }

  async function persistAiApiSettings(overrides: Partial<AppSettings>) {
    const nextSettings: AppSettings = {
      ...initialValue,
      aiApiKey: (aiApiInfo?.apiKey || initialValue.aiApiKey) ?? null,
      aiApiSessionId: selectedAiApiSessionIds[0] ?? null,
      aiApiSessionIds: selectedAiApiSessionIds,
      aiApiPort,
      aiApiAutoStart,
      ...overrides,
    };
    const snapshot = await vaultApi.settingsUpdate(nextSettings);
    if (!mountedRef.current) return;
    onSettingsChange(snapshot);
  }

  async function openLogWindow() {
    try {
      const { isTauriRuntime } = await import("../../api/runtime");
      if (!mountedRef.current) return;
      if (isTauriRuntime()) {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        if (!mountedRef.current) return;
        const existing = await WebviewWindow.getByLabel("api-logs");
        if (!mountedRef.current) return;
        if (existing) { await existing.setFocus(); return; }
        const webview = new WebviewWindow("api-logs", { url: "index.html?logWindow=1", title: "AI API 操作日志", width: 680, height: 480, minWidth: 480, minHeight: 320, resizable: true });
        await webview.once("tauri://error", (event) => {
          if (mountedRef.current) message.error(getErrorMessage(event.payload));
        });
      } else {
        window.open(`${window.location.origin}${window.location.pathname}?logWindow=1`, "api-logs", "width=680,height=480");
      }
    } catch (error) {
      if (mountedRef.current) message.error(getErrorMessage(error));
    }
  }

  function findAiApiSession(sessionId: string | null) {
    if (!sessionId) return null;
    return sessionsById.get(sessionId) ?? null;
  }

  function aiApiSessionCopyLabel(sessionId: string | null) {
    const sessionName = findAiApiSession(sessionId)?.name;
    return sessionName ? `「${sessionName}」` : "该会话";
  }

  function aiApiSessionCopyTooltip(sessionId: string | null, copied: boolean) {
    if (!sessionId) return "请选择会话后复制";
    return copied ? `已复制${aiApiSessionCopyLabel(sessionId)}字段库命令` : `复制${aiApiSessionCopyLabel(sessionId)}字段库命令`;
  }

  function buildApiInfoText(targetSessionId: string) {
    const targetSession = findAiApiSession(targetSessionId);
    const port = aiApiInfo?.port ?? aiApiPort;
    const apiKey = aiApiInfo?.apiKey ?? "";
    const sessionId = targetSession?.id ?? targetSessionId;
    const sessionName = targetSession?.name ?? "";
    const sessionHost = targetSession?.host ?? "";
    const hostLabel = [sessionName, sessionHost].filter((item) => item.length > 0).join(" ");
    return [
      `curl -H "Authorization: Bearer ${apiKey}" http://127.0.0.1:${port}/api/fields`,
      "",
      `会话ID: ${sessionId}`,
      ...(hostLabel ? [`会话主机: ${hostLabel}`] : []),
    ].join("\n");
  }

  function copyApiInfoForSession(targetSessionId: string | null) {
    if (!targetSessionId || !aiApiInfo?.running || !aiApiInfo.apiKey) return;
    void writeClipboardText(buildApiInfoText(targetSessionId)).then((ok) => {
      if (!mountedRef.current) return;
      if (!ok) {
        message.error("复制失败");
        return;
      }
      setCopiedSessionId(targetSessionId);
      setSafeTimeout(() => setCopiedSessionId(null), 2000);
      message.success(`已复制${aiApiSessionCopyLabel(targetSessionId)}字段库命令`);
    });
  }

  function renderAiApiSessionFormRow() {
    return (
      <div className="aiApiFormRow aiApiSessionFormRow">
        <span className="aiApiFormLabel">指定会话</span>
        <div className="aiApiSessionRows">
          {aiApiSessionRows.map((sessionId, index) => {
            const isLastRow = index === aiApiSessionRows.length - 1;
            const canShowAdd = isLastRow && aiApiSessionRows.length < MAX_AI_API_SESSIONS && aiApiSessionRows.length < sessions.length;
            const canAdd = canShowAdd && Boolean(sessionId);
            const isSessionCopied = Boolean(sessionId) && copiedSessionId === sessionId;
            return (
              <div className="aiApiSessionSelectRow" key={index}>
                <Select
                  style={{ flex: 1 }}
                  placeholder="请选择允许访问的会话"
                  allowClear
                  value={sessionId}
                  onChange={(v) => void changeAiApiSession(index, v ?? null)}
                  options={sessionOptions.map((option) => ({
                    ...option,
                    disabled: aiApiSessionRows.some((row, rowIndex) => rowIndex !== index && row === option.value),
                  }))}
                />
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0, justifyContent: "flex-end", width: 112 }}>
                  {aiApiSessionRows.length > 1 && (
                    <Tooltip title="移除指定会话">
                      <Button
                        className="aiApiSessionAction"
                        size="small"
                        icon={<MinusOutlined />}
                        onClick={() => void removeAiApiSessionRow(index)}
                      />
                    </Tooltip>
                  )}
                  {canShowAdd && (
                    <Tooltip title={addAiApiSessionTooltip(sessionId, isLastRow)}>
                      <Button
                        className="aiApiSessionAction"
                        size="small"
                        icon={<PlusOutlined />}
                        disabled={!canAdd}
                        onClick={addAiApiSessionRow}
                      />
                    </Tooltip>
                  )}
                  <Tooltip title={aiApiSessionCopyTooltip(sessionId, isSessionCopied)}>
                    <Button
                      className="aiApiSessionAction"
                      size="small"
                      type="text"
                      icon={isSessionCopied ? <CheckOutlined style={{ color: "#10b981" }} /> : <CopyOutlined />}
                      disabled={!sessionId || !aiApiInfo?.running || !aiApiInfo.apiKey}
                      onClick={() => copyApiInfoForSession(sessionId)}
                    />
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const renderStatusCard = () => {
    return (
      <div className="aiApiPanel">
        <div className="aiApiStatusRow">
          <div className="aiApiStatusGroup">
            <span className="aiApiStatusLabel">服务状态</span>
            <Tooltip title={aiApiStatusTooltip()}>
              <button
                type="button"
                className={`aiApiStatusBadge aiApiStatusBadge-${aiApiInfo?.running ? "running" : "stopped"}`}
                aria-label={aiApiInfo?.running ? "关闭 AI API 服务" : "开启 AI API 服务"}
                aria-pressed={Boolean(aiApiInfo?.running)}
                disabled={aiApiLoading}
                onClick={() => void toggleAiApiStatus()}
              >
                {aiApiLoading ? "处理中" : aiApiInfo?.running ? "运行中" : "已停止"}
              </button>
            </Tooltip>
            {aiApiLogs.length > 0 && (
              <Tooltip title="查看日志">
                <Button size="small" type="link" icon={<FundProjectionScreenOutlined />} onClick={() => void openLogWindow()} />
              </Tooltip>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "12px", color: "#64748b" }}>自动启动</span>
            <Tooltip title={aiApiAutoStart ? "已开启随应用自动启动" : "随应用自动启动"}>
              <Switch
                checked={aiApiAutoStart}
                disabled={selectedAiApiSessionIds.length === 0}
                onChange={(c) => void changeAiApiAutoStart(c)}
              />
            </Tooltip>
          </div>
        </div>
      </div>
    );
  };

  const renderConfigCard = () => {
    return (
      <div className="aiApiPanel">
        <div className="aiApiFormRow">
          <span className="aiApiFormLabel">监听端口</span>
          <InputNumber min={1024} max={65535} precision={0} value={aiApiPort} disabled={aiApiInfo?.running} onChange={(v) => v && setAiApiPort(v)} style={{ width: 120 }} />
        </div>
        {aiApiInfo?.running && aiApiInfo.apiKey && (
          <>
            <div className="aiApiFormRow">
              <span className="aiApiFormLabel">API 地址</span>
              <Input readOnly value={`http://127.0.0.1:${aiApiInfo.port}`} style={{ flex: 1 }} onClick={(event) => event.currentTarget.select()} />
            </div>
            <div className="aiApiFormRow">
              <span className="aiApiFormLabel">API Key</span>
              <Input.Password
                readOnly
                value={aiApiInfo.apiKey}
                className="aiApiKeyInput"
                style={{ flex: 1 }}
                onClick={selectApiKeyInput}
                suffix={(
                  <Tooltip title="重新生成密钥">
                    <Button
                      aria-label="重新生成密钥"
                      className="aiApiKeyRefreshButton"
                      icon={<ReloadOutlined />}
                      size="small"
                      type="text"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation();
                        void regenerateKey();
                      }}
                    />
                  </Tooltip>
                )}
              />
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <Modal open={open} title="AI API 控制" className="aiApiModal" footer={null} onCancel={onClose} destroyOnHidden width={480}>
      <div className="aiApiContent">
        {renderStatusCard()}
        {renderConfigCard()}
        <div className="aiApiPanel">
          {renderAiApiSessionFormRow()}
        </div>
      </div>
    </Modal>
  );
}
