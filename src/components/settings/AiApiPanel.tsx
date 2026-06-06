import { CheckOutlined, CopyOutlined, FundProjectionScreenOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Input, InputNumber, Modal, Select, Switch, Tooltip, message } from "antd";
import { useEffect, useState } from "react";
import type { AppSettings, ConfigSnapshot } from "../../types";
import { appApi, type ApiServerInfo, type ApiLogEntry } from "../../api/appApi";
import { appEvents } from "../../api/appEvents";
import { vaultApi } from "../../api/vaultApi";
import { buildApiDoc } from "../../lib/apiDocTemplate";
import { useMountedRef, useTimeoutRegistry } from "../../lib/reactLifecycle";

interface AiApiPanelProps {
  open: boolean;
  onClose: () => void;
  initialValue: AppSettings;
  sessions: { id: string; name: string; host: string }[];
  onApiServerChange: (running: boolean) => void;
  onSettingsChange: (snapshot: ConfigSnapshot) => void;
}

export function AiApiPanel({ open, onClose, initialValue, sessions, onApiServerChange, onSettingsChange }: AiApiPanelProps) {
  const [aiApiInfo, setAiApiInfo] = useState<ApiServerInfo | null>(null);
  const [aiApiLoading, setAiApiLoading] = useState(false);
  const [aiApiPort, setAiApiPort] = useState(() => initialValue.aiApiPort ?? 19880);
  const [aiApiCopied, setAiApiCopied] = useState(false);
  const [aiApiAutoStart, setAiApiAutoStart] = useState(() => initialValue.aiApiAutoStart ?? false);
  const mountedRef = useMountedRef();
  const setSafeTimeout = useTimeoutRegistry();
  const [aiApiSessionId, setAiApiSessionId] = useState<string | null>(() => {
    const saved = initialValue.aiApiSessionId ?? null;
    if (saved && sessions.some((s) => s.id === saved)) return saved;
    return null;
  });
  const [aiApiLogs, setAiApiLogs] = useState<ApiLogEntry[]>([]);

  useEffect(() => {
    if (!open) return;
    setAiApiSessionId(initialValue.aiApiSessionId ?? null);
    setAiApiPort(initialValue.aiApiPort ?? 19880);
    setAiApiAutoStart(initialValue.aiApiAutoStart ?? false);
  }, [initialValue, open]);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    let unlisten: (() => void) | null = null;
    void appApi.apiServerLogs().then((items) => {
      if (mounted) setAiApiLogs(items);
    }).catch(() => undefined);
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
    });
    return () => { mounted = false; if (unlisten) unlisten(); };
  }, [open]);

  async function refreshAiApiStatus() {
    try {
      const info = await appApi.apiServerStatus();
      if (!mountedRef.current) return;
      setAiApiInfo(info);
      onApiServerChange(info.running);
      if (info.running && info.port) setAiApiPort(info.port);
    } catch { if (mountedRef.current) setAiApiInfo(null); }
  }

  async function startAiApi() {
    setAiApiLoading(true);
    try {
      const info = await appApi.apiServerStart(aiApiPort, aiApiSessionId);
      if (!mountedRef.current) return;
      setAiApiInfo(info);
      onApiServerChange(true);
      await persistAiApiSettings({ aiApiKey: info.apiKey, aiApiPort: info.port || aiApiPort, aiApiSessionId, aiApiAutoStart }).catch(() => undefined);
    } catch (error) { Modal.error({ title: "启动 API 服务失败", content: String(error) }); }
    finally { if (mountedRef.current) setAiApiLoading(false); }
  }

  async function stopAiApi() {
    setAiApiLoading(true);
    try {
      await appApi.apiServerStop();
      if (!mountedRef.current) return;
      setAiApiInfo({ running: false, port: 0, apiKey: "" });
      onApiServerChange(false);
    } catch (error) { Modal.error({ title: "停止 API 服务失败", content: String(error) }); }
    finally { if (mountedRef.current) setAiApiLoading(false); }
  }

  async function regenerateKey() {
    try {
      const info = await appApi.apiServerRegenerateKey();
      if (!mountedRef.current) return;
      setAiApiInfo(info);
      message.success("API Key 已重新生成");
    } catch (error) { Modal.error({ title: "重新生成密钥失败", content: String(error) }); }
  }

  async function changeAiApiSession(sessionId: string | null) {
    setAiApiSessionId(sessionId);
    const nextAutoStart = sessionId ? aiApiAutoStart : false;
    if (!sessionId) setAiApiAutoStart(false);
    try { await persistAiApiSettings({ aiApiSessionId: sessionId, aiApiPort, aiApiAutoStart: nextAutoStart }); }
    catch { message.error("保存失败"); return; }
    if (aiApiInfo?.running) {
      try {
        await appApi.apiServerStop();
        const info = await appApi.apiServerStart(aiApiPort, sessionId);
        if (!mountedRef.current) return;
        setAiApiInfo(info);
        const sessionName = sessions.find((s) => s.id === sessionId)?.name;
        message.success(sessionId ? `已切换至「${sessionName}」，API 已重启` : "已清除会话限制，API 已重启");
      } catch (error) { message.error(`重启 API 服务失败: ${String(error)}`); }
    } else {
      const sessionName = sessions.find((s) => s.id === sessionId)?.name;
      message.success(sessionId ? `已切换至「${sessionName}」` : "已清除会话限制");
    }
  }

  async function changeAiApiAutoStart(checked: boolean) {
    setAiApiAutoStart(checked);
    try {
      await persistAiApiSettings({ aiApiAutoStart: checked, aiApiSessionId, aiApiPort });
      message.success(checked ? "已开启随应用自动启动" : "已关闭自动启动");
    } catch { message.error("保存失败"); setAiApiAutoStart(!checked); }
  }

  async function persistAiApiSettings(overrides: Partial<AppSettings>) {
    const nextSettings: AppSettings = {
      ...initialValue,
      aiApiKey: (aiApiInfo?.apiKey || initialValue.aiApiKey) ?? null,
      aiApiSessionId, aiApiPort, aiApiAutoStart,
      ...overrides,
    };
    const snapshot = await vaultApi.settingsUpdate(nextSettings);
    if (!mountedRef.current) return;
    onSettingsChange(snapshot);
  }

  async function openLogWindow() {
    try {
      const { isTauriRuntime } = await import("../../api/runtime");
      if (isTauriRuntime()) {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const existing = await WebviewWindow.getByLabel("api-logs");
        if (existing) { await existing.setFocus(); return; }
        const webview = new WebviewWindow("api-logs", { url: "index.html?logWindow=1", title: "AI API 操作日志", width: 680, height: 480, minWidth: 480, minHeight: 320, resizable: true });
        await webview.once("tauri://error", (event) => { message.error(String(event.payload)); });
      } else {
        window.open(`${window.location.origin}${window.location.pathname}?logWindow=1`, "api-logs", "width=680,height=480");
      }
    } catch (error) { message.error(String(error)); }
  }

  function copyApiInfo() {
    if (!aiApiInfo?.running) return;
    const selectedSession = aiApiSessionId ? sessions.find((s) => s.id === aiApiSessionId) : null;
    const text = buildApiDoc({
      port: aiApiInfo.port,
      apiKey: aiApiInfo.apiKey,
      sessionId: selectedSession?.id ?? "<sessionId>",
      sessionName: selectedSession?.name,
      sessionHost: selectedSession?.host,
    });
    void navigator.clipboard.writeText(text).then(() => {
      setAiApiCopied(true);
      setSafeTimeout(() => setAiApiCopied(false), 2000);
      message.success("已复制 API 使用说明（HTTP REST）");
    });
  }

  return (
    <Modal open={open} title="AI API 控制" className="aiApiModal" footer={null} onCancel={onClose} destroyOnHidden width={480}>
      <div className="aiApiContent">
        <div className="aiApiPanel">
          <div className="aiApiStatusRow">
            <span className="aiApiStatusLabel">服务状态</span>
            <span className={`aiApiStatusBadge aiApiStatusBadge-${aiApiInfo?.running ? "running" : "stopped"}`}>
              {aiApiInfo?.running ? "运行中" : "已停止"}
            </span>
            {aiApiLogs.length > 0 && (
              <Tooltip title="查看日志">
                <Button size="small" type="link" icon={<FundProjectionScreenOutlined />} onClick={() => void openLogWindow()} />
              </Tooltip>
            )}
          </div>
          <div className="aiApiFormRow">
            <span className="aiApiFormLabel">监听端口</span>
            <InputNumber min={1024} max={65535} precision={0} value={aiApiPort} disabled={aiApiInfo?.running} onChange={(v) => v && setAiApiPort(v)} style={{ width: 120 }} />
          </div>
          <div className="aiApiFormRow">
            <span className="aiApiFormLabel">指定会话</span>
            <Select style={{ flex: 1 }} placeholder="全部会话（AI 可访问所有已连接终端）" allowClear value={aiApiSessionId} onChange={(v) => void changeAiApiSession(v ?? null)} options={sessions.map((s) => ({ label: s.name, value: s.id }))} />
          </div>
          <div className="aiApiFormRow">
            <span className="aiApiFormLabel">自动启动</span>
            <Switch checked={aiApiAutoStart} disabled={!aiApiSessionId} onChange={(c) => void changeAiApiAutoStart(c)} />
            {!aiApiSessionId && <span style={{ fontSize: 12, color: "var(--text-tertiary, #999)" }}>需先指定会话</span>}
          </div>
          {aiApiInfo?.running && aiApiInfo.apiKey && (
            <>
              <div className="aiApiFormRow">
                <span className="aiApiFormLabel">API 地址</span>
                <Input readOnly value={`http://127.0.0.1:${aiApiInfo.port}`} style={{ flex: 1 }} onClick={(e) => (e.target as HTMLInputElement).select()} />
              </div>
              <div className="aiApiFormRow">
                <span className="aiApiFormLabel">API Key</span>
                <Input.Password readOnly value={aiApiInfo.apiKey} style={{ flex: 1 }} onClick={(e) => (e.target as HTMLInputElement).select()} />
                <Tooltip title="重新生成密钥"><Button icon={<ReloadOutlined />} size="small" onClick={() => void regenerateKey()} /></Tooltip>
              </div>
            </>
          )}
        </div>
        {aiApiInfo?.running && aiApiInfo.apiKey && (
          <div className="aiApiPanel aiApiPanel-endpoints">
            <div className="aiApiEndpointHeader">
              <div className="aiApiEndpointTitle">可用接口</div>
              <Tooltip title={aiApiCopied ? "已复制" : "复制 API 使用说明"}>
                <Button icon={aiApiCopied ? <CheckOutlined style={{ color: "#10b981" }} /> : <CopyOutlined />} size="small" type="text" onClick={copyApiInfo} />
              </Tooltip>
            </div>
            <div className="aiApiEndpointScroll">
              <div className="aiApiEndpointItem">
                <code>会话</code>
                <span>sessions · connect · disconnect</span>
              </div>
              <div className="aiApiEndpointItem">
                <code>操作</code>
                <span>exec · files</span>
              </div>
              <div className="aiApiEndpointItem">
                <code>文件传输</code>
                <span>upload · download (Range)</span>
              </div>
              <div className="aiApiEndpointItem">
                <code>隧道</code>
                <span>tunnels CRUD · start · stop</span>
              </div>
              <div className="aiApiEndpointItem">
                <code>备份</code>
                <span>settings · records · run</span>
              </div>
            </div>
          </div>
        )}
        <div className="aiApiActions">
          {aiApiInfo?.running ? (
            <Button danger loading={aiApiLoading} onClick={() => void stopAiApi()}>停止服务</Button>
          ) : (
            <Button type="primary" loading={aiApiLoading} disabled={!aiApiSessionId} onClick={() => void startAiApi()}>启动服务</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
