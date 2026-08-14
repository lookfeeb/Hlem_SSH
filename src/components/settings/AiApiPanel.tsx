import {
  ApiOutlined,
  CheckOutlined,
  CopyOutlined,
  FundProjectionScreenOutlined,
  LockOutlined,
  MinusOutlined,
  PlusOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { Button, Input, InputNumber, Modal, Select, Switch, Tooltip, message } from "antd";
import type { MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AiApiSettings, AppSettings, ConfigSnapshot } from "../../types";
import { appApi, type ApiServerInfo, type ApiLogEntry } from "../../api/appApi";
import { appEvents } from "../../api/appEvents";
import { vaultApi } from "../../api/vaultApi";
import { writeClipboardText } from "../../lib/clipboard";
import { getErrorMessage } from "../../lib/configMapping";
import { createAsyncQueue, isAsyncQueueInvalidatedError } from "../../lib/asyncQueue";
import { mergeApiLogEntries } from "../../lib/apiLogEntries";
import { useMountedRef, useTimeoutRegistry } from "../../lib/reactLifecycle";

interface AiApiPanelProps {
  open: boolean;
  onClose: () => void;
  initialValue: AppSettings;
  sessions: { id: string; name: string; host: string }[];
  onCreateSession: (onCreated?: (sessionId: string) => void) => void;
  onApiServerChange: (running: boolean) => void;
  onSettingsChange: (snapshot: ConfigSnapshot) => void;
}

const MAX_AI_API_SESSIONS = 20;

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

export function AiApiPanel({ open, onClose, initialValue, sessions, onCreateSession, onApiServerChange, onSettingsChange }: AiApiPanelProps) {
  const [aiApiInfo, setAiApiInfo] = useState<ApiServerInfo | null>(null);
  const [aiApiLoading, setAiApiLoading] = useState(false);
  const [aiApiPort, setAiApiPort] = useState(() => initialValue.aiApiPort ?? 19880);
  const [aiApiAutoStart, setAiApiAutoStart] = useState(() => initialValue.aiApiAutoStart ?? false);
  const mountedRef = useMountedRef();
  const settingsMutationVersionRef = useRef(0);
  const statusQueryVersionRef = useRef(0);
  const serviceOperationVersionRef = useRef(0);
  const settingsSaveQueue = useMemo(() => createAsyncQueue(), []);
  const setSafeTimeout = useTimeoutRegistry();
  const [aiApiSessionRows, setAiApiSessionRows] = useState<Array<string | null>>(() => initialAiApiSessionRows(initialValue, sessions));
  const [aiApiLogs, setAiApiLogs] = useState<ApiLogEntry[]>([]);
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const availableAiApiSessionIdsKey = sessions.map((session) => session.id).join("|");
  const initialAiApiSessionIdsKey = [
    ...(initialValue.aiApiSessionIds ?? []),
    initialValue.aiApiSessionId ?? "",
  ].join("|");
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const sessionOptions = useMemo(
    () => sessions.map((session) => ({ label: session.name, value: session.id })),
    [sessions],
  );
  const selectedAiApiSessionIds = useMemo(() => compactAiApiSessionRows(aiApiSessionRows), [aiApiSessionRows]);

  useEffect(() => {
    if (!open) return;
    settingsMutationVersionRef.current += 1;
    setAiApiSessionRows(initialAiApiSessionRows(initialValue, sessions));
    setAiApiPort(initialValue.aiApiPort ?? 19880);
    setAiApiAutoStart(initialValue.aiApiAutoStart ?? false);
  }, [
    availableAiApiSessionIdsKey,
    initialAiApiSessionIdsKey,
    initialValue.aiApiAutoStart,
    initialValue.aiApiPort,
    open,
  ]);

  useEffect(() => {
    if (open) return;
    settingsMutationVersionRef.current += 1;
    serviceOperationVersionRef.current += 1;
    settingsSaveQueue.invalidate();
    setAiApiLoading(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    let unlisten: (() => void) | null = null;
    let unlistenStatus: (() => void) | null = null;
    void appEvents.onApiLog((entry) => {
      if (!mounted) return;
      setAiApiLogs((current) => mergeApiLogEntries(current, [entry]));
    }).then((u) => {
      if (!mounted) { u(); return; }
      unlisten = u;
      void appApi.apiServerLogs().then((items) => {
        if (mounted) setAiApiLogs((current) => mergeApiLogEntries(current, items));
      }).catch((error) => {
        console.warn("[helm] failed to load api logs:", getErrorMessage(error));
      });
    }).catch((error) => {
      console.warn("[helm] failed to subscribe api logs:", getErrorMessage(error));
    });
    void appEvents.onApiStatus((info) => {
      if (!mounted) return;
      statusQueryVersionRef.current += 1;
      setAiApiInfo(info);
      onApiServerChange(info.running);
      if (info.running && info.port) setAiApiPort(info.port);
    }).then((u) => {
      if (!mounted) { u(); return; }
      unlistenStatus = u;
      void refreshAiApiStatus();
    }).catch((error) => {
      console.warn("[helm] failed to subscribe api status:", getErrorMessage(error));
    });
    return () => {
      mounted = false;
      if (unlisten) unlisten();
      if (unlistenStatus) unlistenStatus();
    };
  }, [open]);

  async function refreshAiApiStatus() {
    const queryVersion = ++statusQueryVersionRef.current;
    try {
      const info = await appApi.apiServerStatus();
      if (!mountedRef.current || queryVersion !== statusQueryVersionRef.current) return;
      setAiApiInfo(info);
      onApiServerChange(info.running);
      if (info.running && info.port) setAiApiPort(info.port);
    } catch (error) {
      if (!mountedRef.current || queryVersion !== statusQueryVersionRef.current) return;
      console.warn("[helm] failed to refresh ai api status:", getErrorMessage(error));
      setAiApiInfo(null);
    }
  }

  async function startAiApi() {
    const mutationVersion = ++settingsMutationVersionRef.current;
    const operationVersion = ++serviceOperationVersionRef.current;
    statusQueryVersionRef.current += 1;
    setAiApiLoading(true);
    try {
      const result = await appApi.apiServerConfigureAndStart(
        aiApiPort,
        selectedAiApiSessionIds,
        aiApiAutoStart,
      );
      if (!mountedRef.current || operationVersion !== serviceOperationVersionRef.current) return;
      setAiApiInfo(result.info);
      onApiServerChange(true);
      onSettingsChange(result.snapshot);
    } catch (error) {
      const status = await appApi.apiServerStatus().catch(() => null);
      if (
        !mountedRef.current
        || operationVersion !== serviceOperationVersionRef.current
        || mutationVersion !== settingsMutationVersionRef.current
      ) return;
      if (status) {
        setAiApiInfo(status);
        onApiServerChange(status.running);
      }
      Modal.error({ title: "启动 API 服务失败", content: getErrorMessage(error) });
    }
    finally {
      if (mountedRef.current && operationVersion === serviceOperationVersionRef.current) {
        setAiApiLoading(false);
      }
    }
  }

  async function stopAiApi() {
    const operationVersion = ++serviceOperationVersionRef.current;
    statusQueryVersionRef.current += 1;
    setAiApiLoading(true);
    try {
      await appApi.apiServerStop();
      if (!mountedRef.current || operationVersion !== serviceOperationVersionRef.current) return;
      setAiApiInfo((prev) => ({
        running: false,
        port: prev?.port ?? aiApiPort,
        apiKey: prev?.apiKey ?? initialValue.aiApiKey ?? "",
      }));
      onApiServerChange(false);
      message.success("AI API 已关闭");
    } catch (error) {
      if (mountedRef.current && operationVersion === serviceOperationVersionRef.current) {
        Modal.error({ title: "关闭 API 服务失败", content: getErrorMessage(error) });
      }
    }
    finally {
      if (mountedRef.current && operationVersion === serviceOperationVersionRef.current) {
        setAiApiLoading(false);
      }
    }
  }

  async function toggleAiApiStatus() {
    if (aiApiLoading) return;
    if (aiApiInfo?.running) {
      await stopAiApi();
      return;
    }
    await startAiApi();
  }

  function aiApiStatusTooltip() {
    if (aiApiLoading) return aiApiInfo?.running ? "正在关闭 API 服务" : "正在开启 API 服务";
    return aiApiInfo?.running ? "点击关闭 API 服务" : "点击开启 API 服务";
  }

  async function regenerateKey() {
    if (aiApiLoading) return;
    const operationVersion = ++serviceOperationVersionRef.current;
    statusQueryVersionRef.current += 1;
    setAiApiLoading(true);
    try {
      const info = await appApi.apiServerRegenerateKey();
      if (!mountedRef.current || operationVersion !== serviceOperationVersionRef.current) return;
      setAiApiInfo(info);
      const snapshot = await vaultApi.snapshot();
      if (!mountedRef.current || operationVersion !== serviceOperationVersionRef.current) return;
      onSettingsChange(snapshot);
      message.success("API Key 已重新生成");
    } catch (error) {
      if (mountedRef.current && operationVersion === serviceOperationVersionRef.current) {
        Modal.error({ title: "重新生成密钥失败", content: getErrorMessage(error) });
      }
    } finally {
      if (mountedRef.current && operationVersion === serviceOperationVersionRef.current) {
        setAiApiLoading(false);
      }
    }
  }

  function addAiApiSessionRow() {
    if (aiApiSessionRows.length >= MAX_AI_API_SESSIONS) return;
    const selectedIds = compactAiApiSessionRows(aiApiSessionRows);
    const hasUnusedSession = sessions.some((session) => !selectedIds.includes(session.id));

    if (!hasUnusedSession) {
      settingsMutationVersionRef.current += 1;
      const previousRows = aiApiSessionRows;
      onCreateSession((sessionId) => {
        if (selectedIds.includes(sessionId) || selectedIds.length >= MAX_AI_API_SESSIONS) return;
        void saveAiApiSessionRows([...selectedIds, sessionId], previousRows);
      });
      return;
    }

    if (!aiApiSessionRows[aiApiSessionRows.length - 1]) return;
    settingsMutationVersionRef.current += 1;
    setAiApiSessionRows((prev) => [...prev, null]);
  }

  function addAiApiSessionTooltip(sessionId: string | null, isLastRow: boolean) {
    if (!isLastRow) return "";
    if (aiApiSessionRows.length >= MAX_AI_API_SESSIONS) return "最多指定 20 个会话";
    const selectedIds = compactAiApiSessionRows(aiApiSessionRows);
    const hasUnusedSession = sessions.some((session) => !selectedIds.includes(session.id));
    if (!hasUnusedSession) return sessions.length > 0 ? "新建 SSH 会话并自动加入授权" : "新建首个 SSH 会话并自动加入授权";
    if (!sessionId) return "请先选择当前会话";
    return "添加授权会话";
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
    const mutationVersion = ++settingsMutationVersionRef.current;
    const nextRows = normalizeAiApiSessionRows(nextRowsInput);
    const nextSessionIds = compactAiApiSessionRows(nextRows);
    const previousAutoStart = aiApiAutoStart;
    const nextAutoStart = nextSessionIds.length > 0 ? aiApiAutoStart : false;

    setAiApiSessionRows(nextRows);
    if (!nextAutoStart) setAiApiAutoStart(false);
    try {
      await persistAiApiSettings({
        sessionIds: nextSessionIds,
        port: aiApiPort,
        autoStart: nextAutoStart,
      });
      if (!mountedRef.current) return;
    } catch (error) {
      if (isAsyncQueueInvalidatedError(error)) return;
      if (mountedRef.current && mutationVersion === settingsMutationVersionRef.current) {
        message.error(`保存失败：${getErrorMessage(error)}`);
        setAiApiSessionRows(previousRows);
        setAiApiAutoStart(previousAutoStart);
      }
      return;
    }
    if (mountedRef.current && mutationVersion === settingsMutationVersionRef.current) {
      message.success(nextSessionIds.length > 0 ? "指定会话已更新" : "授权会话已清空，API 已停止");
    }
  }

  async function changeAiApiAutoStart(checked: boolean) {
    const mutationVersion = ++settingsMutationVersionRef.current;
    setAiApiAutoStart(checked);
    try {
      await persistAiApiSettings({
        autoStart: checked,
        sessionIds: selectedAiApiSessionIds,
        port: aiApiPort,
      });
      if (!mountedRef.current) return;
      if (mutationVersion === settingsMutationVersionRef.current) {
        message.success(checked ? "已开启随应用自动启动" : "已关闭自动启动");
      }
    } catch (error) {
      if (isAsyncQueueInvalidatedError(error)) return;
      if (mountedRef.current && mutationVersion === settingsMutationVersionRef.current) {
        message.error(`保存失败：${getErrorMessage(error)}`);
        setAiApiAutoStart(!checked);
      }
    }
  }

  async function persistAiApiSettings(overrides: Partial<AiApiSettings>) {
    const nextSettings: AiApiSettings = {
      sessionIds: selectedAiApiSessionIds,
      port: aiApiPort,
      autoStart: aiApiAutoStart,
      ...overrides,
    };
    const snapshot = await settingsSaveQueue.enqueue(() => vaultApi.settingsAiApiUpdate(nextSettings));
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
        const webview = new WebviewWindow("api-logs", { url: "index.html?logWindow=1", title: "AI API 操作日志", width: 680, height: 480, minWidth: 480, minHeight: 320, resizable: true, devtools: import.meta.env.DEV });
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
      <div className="aiApiSessionRows">
        {aiApiSessionRows.map((sessionId, index) => {
          const isLastRow = index === aiApiSessionRows.length - 1;
          const selectedIds = compactAiApiSessionRows(aiApiSessionRows);
          const hasUnusedSession = sessions.some((session) => !selectedIds.includes(session.id));
          const canShowAdd = isLastRow && aiApiSessionRows.length < MAX_AI_API_SESSIONS;
          const canAdd = canShowAdd && (Boolean(sessionId) || !hasUnusedSession);
          const isSessionCopied = Boolean(sessionId) && copiedSessionId === sessionId;
          return (
            <div className="aiApiSessionSelectRow" key={index}>
              <span className="aiApiSessionIndex" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <Select
                className="aiApiSessionSelect"
                placeholder={sessions.length > 0 ? "请选择允许访问的会话" : "暂无可用 SSH 会话"}
                aria-label={`授权会话 ${index + 1}`}
                allowClear
                value={sessionId}
                disabled={sessions.length === 0}
                onChange={(v) => void changeAiApiSession(index, v ?? null)}
                options={sessionOptions.map((option) => ({
                  ...option,
                  disabled: aiApiSessionRows.some((row, rowIndex) => rowIndex !== index && row === option.value),
                }))}
              />
              <div className="aiApiSessionActions">
                {aiApiSessionRows.length > 1 && (
                  <Tooltip title="移除指定会话">
                    <Button
                      className="aiApiSessionAction is-remove"
                      size="small"
                      icon={<MinusOutlined />}
                      aria-label={`移除授权会话 ${index + 1}`}
                      onClick={() => void removeAiApiSessionRow(index)}
                    />
                  </Tooltip>
                )}
                {canShowAdd && (
                  <Tooltip title={addAiApiSessionTooltip(sessionId, isLastRow)}>
                    <Button
                      className="aiApiSessionAction is-add"
                      size="small"
                      icon={<PlusOutlined />}
                      aria-label="添加授权会话"
                      disabled={!canAdd}
                      onClick={addAiApiSessionRow}
                    />
                  </Tooltip>
                )}
                <Tooltip title={aiApiSessionCopyTooltip(sessionId, isSessionCopied)}>
                  <Button
                    className="aiApiSessionAction is-copy"
                    size="small"
                    type="text"
                    icon={isSessionCopied ? <CheckOutlined /> : <CopyOutlined />}
                    aria-label={isSessionCopied ? "命令已复制" : `复制授权会话 ${index + 1} 的字段库命令`}
                    disabled={!sessionId || !aiApiInfo?.running || !aiApiInfo.apiKey}
                    onClick={() => copyApiInfoForSession(sessionId)}
                  />
                </Tooltip>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const renderStatusCard = () => {
    const running = Boolean(aiApiInfo?.running);
    return (
      <section className="aiApiCard aiApiControlCard">
        <div className="aiApiSectionHeading">
          <span className="aiApiSectionIcon"><PoweroffOutlined /></span>
          <div className="aiApiSectionCopy">
            <strong>服务控制</strong>
            <span>控制本机接口的运行状态</span>
          </div>
        </div>

        <div className={`aiApiServiceSurface ${running ? "is-running" : "is-stopped"}`} aria-live="polite">
          <div className="aiApiServiceState">
            <span className="aiApiServicePulse" aria-hidden="true" />
            <div>
              <strong>{aiApiLoading ? "正在处理服务状态" : running ? "本地 API 正在运行" : "本地 API 已停止"}</strong>
              <span>{running ? `监听 127.0.0.1:${aiApiInfo?.port ?? aiApiPort}` : "启动后即可通过本机地址调用"}</span>
            </div>
          </div>
          <div className="aiApiServiceActions">
            {aiApiLogs.length > 0 && (
              <Button className="aiApiLogsButton" icon={<FundProjectionScreenOutlined />} onClick={() => void openLogWindow()}>
                操作日志
              </Button>
            )}
            <Tooltip title={aiApiStatusTooltip()}>
              <Button
                className={`aiApiServiceToggle ${running ? "is-stop" : "is-start"}`}
                type={running ? "default" : "primary"}
                icon={running ? <PoweroffOutlined /> : <ThunderboltOutlined />}
                loading={aiApiLoading}
                disabled={!running && selectedAiApiSessionIds.length === 0}
                onClick={() => void toggleAiApiStatus()}
              >
                {running ? "停止服务" : "启动服务"}
              </Button>
            </Tooltip>
          </div>
        </div>

        <div className="aiApiAutoStartRow">
          <div>
            <strong>随应用自动启动</strong>
            <span>{selectedAiApiSessionIds.length > 0 ? "启动 HelM 时自动恢复本地 API" : "请先至少选择一个授权会话"}</span>
          </div>
          <Tooltip title={aiApiAutoStart ? "已开启随应用自动启动" : "随应用自动启动"}>
            <Switch
              checked={aiApiAutoStart}
              disabled={selectedAiApiSessionIds.length === 0}
              onChange={(c) => void changeAiApiAutoStart(c)}
            />
          </Tooltip>
        </div>
      </section>
    );
  };

  const renderConfigCard = () => {
    return (
      <section className="aiApiCard aiApiConfigCard">
        <div className="aiApiSectionHeading">
          <span className="aiApiSectionIcon"><ApiOutlined /></span>
          <div className="aiApiSectionCopy">
            <strong>接口配置</strong>
            <span>仅监听本机回环地址，不对外网开放</span>
          </div>
        </div>

        <div className="aiApiConfigFields">
          <div className="aiApiField">
            <div className="aiApiFieldLabel">
              <label htmlFor="aiApiPort">监听端口</label>
              <span>1024–65535</span>
            </div>
            <InputNumber id="aiApiPort" min={1024} max={65535} precision={0} value={aiApiPort} disabled={aiApiInfo?.running} onChange={(v) => v && setAiApiPort(v)} />
          </div>
        {aiApiInfo?.running && aiApiInfo.apiKey && (
          <>
            <div className="aiApiField aiApiFieldWide">
              <div className="aiApiFieldLabel">
                <label htmlFor="aiApiAddress">API 地址</label>
                <span>点击可全选</span>
              </div>
              <Input id="aiApiAddress" readOnly value={`http://127.0.0.1:${aiApiInfo.port}`} onClick={(event) => event.currentTarget.select()} />
            </div>
            <div className="aiApiField aiApiFieldWide">
              <div className="aiApiFieldLabel">
                <label htmlFor="aiApiKey">API Key</label>
                <span>请勿发送给不受信任的应用</span>
              </div>
              <Input.Password
                id="aiApiKey"
                readOnly
                value={aiApiInfo.apiKey}
                className="aiApiKeyInput"
                onClick={selectApiKeyInput}
                suffix={(
                  <Tooltip title="重新生成密钥">
                    <Button
                      aria-label="重新生成密钥"
                      className="aiApiKeyRefreshButton"
                      icon={<ReloadOutlined />}
                      size="small"
                      type="text"
                      disabled={aiApiLoading}
                      loading={aiApiLoading}
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
        {!aiApiInfo?.running && (
          <div className="aiApiConfigPlaceholder">
            <LockOutlined />
            <div><strong>接口凭证尚未生成</strong><span>启动服务后会显示 API 地址与访问密钥</span></div>
          </div>
        )}
        </div>
      </section>
    );
  };

  return (
    <Modal open={open} title={null} className="aiApiModal" footer={null} onCancel={onClose} destroyOnHidden width={720} centered>
      <div className="aiApiModalShell">
        <header className="aiApiModalHeader">
          <span className="aiApiModalHeaderIcon" aria-hidden="true"><ThunderboltOutlined /></span>
          <div className="aiApiModalHeaderCopy">
            <strong>AI API 控制</strong>
            <span>管理本地接口、访问凭证与授权会话</span>
          </div>
          <span className={`aiApiHeaderStatus ${aiApiInfo?.running ? "is-running" : "is-stopped"}`}>
            <i aria-hidden="true" />
            {aiApiLoading ? "处理中" : aiApiInfo?.running ? "服务运行中" : "服务未运行"}
          </span>
        </header>

        <div className="aiApiModalBody">
          <div className="aiApiContent">
            {renderStatusCard()}
            {renderConfigCard()}
            <section className="aiApiCard aiApiSessionsCard">
              <div className="aiApiSectionHeading">
                <span className="aiApiSectionIcon"><SafetyCertificateOutlined /></span>
                <div className="aiApiSectionCopy">
                  <strong>授权会话</strong>
                  <span>仅允许已选择的 SSH 会话通过 API 执行操作</span>
                </div>
                <span className="aiApiSessionCount">{selectedAiApiSessionIds.length} / {MAX_AI_API_SESSIONS}</span>
              </div>
              {renderAiApiSessionFormRow()}
            </section>
          </div>
        </div>

        <footer className="aiApiModalFooter">
          <div className="aiApiSecurityNote">
            <LockOutlined />
            <span>接口仅绑定 127.0.0.1，密钥与授权范围保存在本机。</span>
          </div>
          <Button className="aiApiCloseButton" onClick={onClose}>完成</Button>
        </footer>
      </div>
    </Modal>
  );
}
