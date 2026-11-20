import "../../styles/modals/modal-ai.css";
import {
  ApiOutlined,
  FundProjectionScreenOutlined,
  LockOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { Button, Input, InputNumber, Modal, Tooltip, message } from "antd";
import type { MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { AppSettings, ConfigSnapshot } from "../../types";
import { appApi, type ApiServerInfo, type ApiLogEntry } from "../../api/appApi";
import { appEvents } from "../../api/appEvents";
import { vaultApi } from "../../api/vaultApi";
import { getErrorMessage } from "../../lib/configMapping";
import { mergeApiLogEntries } from "../../lib/apiLogEntries";
import { useMountedRef } from "../../lib/reactLifecycle";

interface AiApiPanelProps {
  open: boolean;
  onClose: () => void;
  initialValue: AppSettings;
  onApiServerChange: (info: ApiServerInfo) => void;
  onSettingsChange: (snapshot: ConfigSnapshot) => void;
}

export function AiApiPanel({ open, onClose, initialValue, onApiServerChange, onSettingsChange }: AiApiPanelProps) {
  const [aiApiInfo, setAiApiInfo] = useState<ApiServerInfo | null>(null);
  const [aiApiLoading, setAiApiLoading] = useState(false);
  const [aiApiPort, setAiApiPort] = useState(() => initialValue.aiApiPort ?? 19880);
  const mountedRef = useMountedRef();
  const settingsMutationVersionRef = useRef(0);
  const statusQueryVersionRef = useRef(0);
  const serviceOperationVersionRef = useRef(0);
  const [aiApiLogs, setAiApiLogs] = useState<ApiLogEntry[]>([]);
  useEffect(() => {
    if (!open) return;
    settingsMutationVersionRef.current += 1;
    setAiApiPort(initialValue.aiApiPort ?? 19880);
  }, [initialValue.aiApiPort, open]);

  useEffect(() => {
    if (open) return;
    settingsMutationVersionRef.current += 1;
    serviceOperationVersionRef.current += 1;
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
      onApiServerChange(info);
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
      onApiServerChange(info);
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
      const result = await appApi.apiServerConfigureAndStart(aiApiPort);
      if (!mountedRef.current || operationVersion !== serviceOperationVersionRef.current) return;
      setAiApiInfo(result.info);
      onApiServerChange(result.info);
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
        onApiServerChange(status);
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
      const stopped = {
        running: false,
        port: aiApiInfo?.port ?? aiApiPort,
        apiKey: aiApiInfo?.apiKey ?? initialValue.aiApiKey ?? "",
      };
      setAiApiInfo(stopped);
      onApiServerChange(stopped);
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
    if (aiApiInfo?.running || aiApiInfo?.starting) {
      await stopAiApi();
      return;
    }
    await startAiApi();
  }

  function aiApiStatusTooltip() {
    if (aiApiInfo?.starting) return "取消本次自动启动";
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

  function selectApiKeyInput(event: MouseEvent<HTMLInputElement>) {
    event.currentTarget.select();
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
        const webview = new WebviewWindow("api-logs", { url: "index.html?logWindow=1", title: "AI API 操作日志", width: 1040, height: 740, minWidth: 640, minHeight: 480, center: true, resizable: true, devtools: import.meta.env.DEV });
        await webview.once("tauri://error", (event) => {
          if (mountedRef.current) message.error(getErrorMessage(event.payload));
        });
      } else {
        window.open(`${window.location.origin}${window.location.pathname}?logWindow=1`, "api-logs", "width=1040,height=740");
      }
    } catch (error) {
      if (mountedRef.current) message.error(getErrorMessage(error));
    }
  }

  const renderStatusCard = () => {
    const running = Boolean(aiApiInfo?.running);
    const starting = Boolean(aiApiInfo?.starting);
    return (
      <section className="aiApiCard aiApiControlCard">
        <div className="aiApiSectionHeading">
          <span className="aiApiSectionIcon"><PoweroffOutlined /></span>
          <div className="aiApiSectionCopy">
            <strong>服务控制</strong>
            <span>随应用自动启动，可临时停止服务</span>
          </div>
        </div>

        <div className={`aiApiServiceSurface ${running ? "is-running" : starting ? "is-starting" : "is-stopped"}`} aria-live="polite">
          <div className="aiApiServiceState">
            <span className="aiApiServicePulse" aria-hidden="true" />
            <div>
              <strong>{aiApiLoading ? "正在处理服务状态" : running ? "本地 API 正在运行" : starting ? "本地 API 正在启动" : aiApiInfo?.error ? "本地 API 启动失败" : "本地 API 已停止"}</strong>
              <span>{running ? `监听 127.0.0.1:${aiApiInfo?.port ?? aiApiPort}` : starting ? `正在准备本机端口 ${aiApiInfo?.port ?? aiApiPort}，先等待 10 秒，必要时延长至 15 秒` : aiApiInfo?.error ?? "启动后即可通过本机地址调用"}</span>
            </div>
          </div>
          <div className="aiApiServiceActions">
            {aiApiLogs.length > 0 && (
              <Button className="aiApiLogsButton is-logs" icon={<FundProjectionScreenOutlined />} onClick={() => void openLogWindow()}>
                操作日志
              </Button>
            )}
            <Tooltip title={aiApiStatusTooltip()}>
              <Button
                className={`aiApiServiceToggle ${running || starting ? "is-stop" : "is-start"}`}
                type={running || starting ? "default" : "primary"}
                icon={running || starting ? <PoweroffOutlined /> : <ThunderboltOutlined />}
                loading={aiApiLoading}
                onClick={() => void toggleAiApiStatus()}
              >
                {running ? "停止服务" : starting ? "取消启动" : "启动服务"}
              </Button>
            </Tooltip>
          </div>
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
          <div className={`aiApiEndpointFields ${aiApiInfo?.running && aiApiInfo.apiKey ? "is-running" : "is-stopped"}`}>
            {aiApiInfo?.running && aiApiInfo.apiKey && (
              <div className="aiApiField aiApiAddressField">
                <div className="aiApiFieldLabel">
                  <label htmlFor="aiApiAddress">API 地址</label>
                  <span>点击可全选</span>
                </div>
                <Input id="aiApiAddress" readOnly value="http://127.0.0.1" onClick={(event) => event.currentTarget.select()} />
              </div>
            )}
            <div className="aiApiField aiApiPortField">
              <div className="aiApiFieldLabel">
                <label htmlFor="aiApiPort">监听端口</label>
                <span>1024–65535</span>
              </div>
              <InputNumber id="aiApiPort" min={1024} max={65535} precision={0} value={aiApiPort} disabled={aiApiInfo?.running} onChange={(v) => v && setAiApiPort(v)} />
            </div>
          </div>
          {aiApiInfo?.running && aiApiInfo.apiKey && (
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
            <span>管理本地接口与访问凭证</span>
          </div>
          <span className={`aiApiHeaderStatus ${aiApiInfo?.running ? "is-running" : aiApiInfo?.starting ? "is-starting" : "is-stopped"}`}>
            <i aria-hidden="true" />
            {aiApiLoading ? "处理中" : aiApiInfo?.running ? "服务运行中" : aiApiInfo?.starting ? "正在启动" : aiApiInfo?.error ? "启动失败" : "服务未运行"}
          </span>
        </header>

        <div className="aiApiModalBody">
          <div className="aiApiContent">
            {renderStatusCard()}
            {renderConfigCard()}
          </div>
        </div>

        <footer className="aiApiModalFooter">
          <div className="aiApiSecurityNote">
            <LockOutlined />
            <span>所有已保存主机均可通过 API 访问；在主机卡片上复制调用命令。</span>
          </div>
          <Button className="aiApiCloseButton" onClick={onClose}>完成</Button>
        </footer>
      </div>
    </Modal>
  );
}
