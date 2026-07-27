import {
  ApartmentOutlined,
  AppstoreOutlined,
  CheckCircleOutlined,
  ExportOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { App as AntdApp, Button, Form, Modal } from "antd";
import { useEffect, useState } from "react";
import type { AppInfo, AppSettings, ConfigSnapshot, UpdateInfo } from "../types";
import { getErrorMessage } from "../lib/configMapping";

import { ProxyForm } from "./settings/ProxyForm";
import { AiApiPanel } from "./settings/AiApiPanel";
import { AboutModal } from "./settings/AboutModal";
import { ReleaseNotesModal } from "./settings/ReleaseNotesModal";

interface SettingsModalProps {
  open: boolean;
  initialValue: AppSettings;
  sessions: { id: string; name: string; host: string; state: string }[];
  onClose: () => void;
  onSubmit: (settings: AppSettings) => Promise<void>;
  onBackupOpen: () => void;
  onTunnelOpen: () => void;
  onCreateSession: (onCreated?: (sessionId: string) => void) => void;
  onApiServerChange: (running: boolean) => void;
  onSettingsChange: (snapshot: ConfigSnapshot) => void;
  aiApiOpen: boolean;
  onAiApiOpenChange: (open: boolean) => void;
  appInfo: AppInfo | null;
  updateInfo: UpdateInfo | null;
  updateError: string | null;
  updateChecking: boolean;
  updateDownloading: boolean;
  downloadedUpdatePath: string | null;
  updateRepo: string;
  onCheckUpdate: (manual?: boolean) => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onIgnoreUpdate: () => Promise<void>;
  onOpenDatabaseDir: () => Promise<void>;
  onOpenPathDir: (path: string) => Promise<void>;
  onOpenExternalUrl: (url: string) => Promise<void>;
}

interface SettingsFormValues {
  enabled: boolean;
  kind: "socks5" | "httpConnect";
  host: string;
  port: number;
}

export function SettingsModal({
  open, initialValue, sessions, onClose, onSubmit, onBackupOpen, onTunnelOpen, onCreateSession,
  onApiServerChange, onSettingsChange, aiApiOpen, onAiApiOpenChange,
  appInfo, updateInfo, updateError, updateChecking, updateDownloading,
  downloadedUpdatePath, updateRepo, onCheckUpdate, onDownloadUpdate, onInstallUpdate,
  onIgnoreUpdate, onOpenDatabaseDir, onOpenPathDir, onOpenExternalUrl,
}: SettingsModalProps) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<SettingsFormValues>();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const enabled = Form.useWatch("enabled", form) ?? false;
  const proxyKind = Form.useWatch("kind", form) ?? initialValue.proxy?.kind ?? "socks5";
  const proxyHost = Form.useWatch("host", form) ?? initialValue.proxy?.host ?? "127.0.0.1";
  const proxyPort = Form.useWatch("port", form) ?? initialValue.proxy?.port ?? 1080;
  const proxyKindLabel = proxyKind === "httpConnect" ? "HTTP CONNECT" : "SOCKS5";

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      enabled: initialValue.proxy?.enabled ?? false,
      kind: initialValue.proxy?.kind ?? "socks5",
      host: initialValue.proxy?.host ?? "127.0.0.1",
      port: initialValue.proxy?.port ?? 1080,
    });
  }, [form, initialValue, open]);

  async function submit() {
    if (saving) return;
    setSaving(true);
    try {
      const values = await form.validateFields();
      await onSubmit({
        ...initialValue,
        proxy: values.enabled ? { enabled: true, kind: values.kind, host: values.host.trim(), port: values.port } : null,
      });
    } catch (error) {
      if (!(error && typeof error === "object" && "errorFields" in error)) {
        message.error(getErrorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  }

  function close() {
    if (!saving) onClose();
  }

  return (
    <>
      <Modal
        open={open}
        className="settingsModal"
        title={
          <div className="settingsModalTitlebar">
            <span className="settingsModalTitleIcon" aria-hidden="true"><SettingOutlined /></span>
            <div className="settingsModalTitleCopy">
              <strong>全局设置</strong>
              <span>管理本机数据、连接能力与应用网络路径</span>
            </div>
            <span className={`settingsModalHeaderStatus ${enabled ? "is-enabled" : ""}`}>
              <GlobalOutlined />
              {enabled ? "全局代理已启用" : "当前直接连接"}
            </span>
          </div>
        }
        footer={null}
        onCancel={close}
        destroyOnHidden
        width={900}
        centered
        closable={!saving}
        keyboard={!saving}
        maskClosable={!saving}
      >
        <div className="settingsModalLayout">
          <aside className="settingsModalSidebar">
            <div className="settingsSidebarLabel">设置概览</div>
            <div className="settingsOverviewCard">
              <div className="settingsOverviewHead">
                <span aria-hidden="true"><SettingOutlined /></span>
                <div>
                  <strong>本机工作区</strong>
                  <small>所有设置仅应用于当前设备</small>
                </div>
              </div>
              <div className="settingsOverviewDivider" />
              <div className="settingsOverviewRow">
                <span>功能入口</span>
                <strong>4 项</strong>
              </div>
              <div className="settingsOverviewRow">
                <span>网络路径</span>
                <strong className={enabled ? "is-enabled" : ""}>{enabled ? "代理连接" : "直接连接"}</strong>
              </div>
              <div className="settingsOverviewRoute" title={enabled ? `${proxyKindLabel} · ${proxyHost}:${proxyPort}` : "未启用应用内全局代理"}>
                <GlobalOutlined />
                <span>{enabled ? `${proxyKindLabel} · ${proxyHost}:${proxyPort}` : "未启用应用内全局代理"}</span>
              </div>
            </div>

            <div className="settingsSidebarLabel">配置区域</div>
            <div className="settingsSidebarSections">
              <div className="settingsSidebarSection is-services">
                <span className="settingsSidebarStep">01</span>
                <div><strong>应用与服务</strong><small>备份、隧道、AI 与版本</small></div>
                <AppstoreOutlined />
              </div>
              <div className={`settingsSidebarSection is-proxy ${enabled ? "is-active" : ""}`}>
                <span className="settingsSidebarStep">02</span>
                <div><strong>网络代理</strong><small>{enabled ? "已配置应用代理路径" : "当前保持直接连接"}</small></div>
                <GlobalOutlined />
              </div>
            </div>

            <div className="settingsSecurityNote">
              <SafetyCertificateOutlined />
              <p>设置及代理信息保存在本机，不会同步到远程服务。</p>
            </div>
          </aside>

          <main className="settingsModalWorkspace">
            <div className="settingsModalScroll">
              <section className="settingsWorkspacePanel settingsServicesPanel">
                <div className="settingsPanelHeader">
                  <span className="settingsPanelIcon is-services" aria-hidden="true"><AppstoreOutlined /></span>
                  <div className="settingsPanelHeading">
                    <strong>应用与服务</strong>
                    <span>集中进入常用的数据、连接和本机能力</span>
                  </div>
                  <span className="settingsPanelBadge">4 个入口</span>
                </div>

                <div className="settingsShortcutGrid">
                  <Button block className="settingsShortcutCard is-backup" onClick={onBackupOpen}>
                    <span className="settingsShortcutIcon" aria-hidden="true"><ExportOutlined /></span>
                    <span className="settingsShortcutCopy"><strong>数据备份与恢复</strong><small>导出、恢复并管理自动备份</small></span>
                    <span className="settingsShortcutArrow" aria-hidden="true"><RightOutlined /></span>
                  </Button>
                  <Button block className="settingsShortcutCard is-tunnel" onClick={onTunnelOpen}>
                    <span className="settingsShortcutIcon" aria-hidden="true"><ApartmentOutlined /></span>
                    <span className="settingsShortcutCopy"><strong>SSH 隧道管理</strong><small>配置端口转发与动态代理</small></span>
                    <span className="settingsShortcutArrow" aria-hidden="true"><RightOutlined /></span>
                  </Button>
                  <Button block className="settingsShortcutCard is-ai" onClick={() => onAiApiOpenChange(true)}>
                    <span className="settingsShortcutIcon" aria-hidden="true"><ThunderboltOutlined /></span>
                    <span className="settingsShortcutCopy"><strong>AI API 控制</strong><small>管理本地接口与访问能力</small></span>
                    <span className="settingsShortcutArrow" aria-hidden="true"><RightOutlined /></span>
                  </Button>
                  <Button block className="settingsShortcutCard is-about" onClick={() => setAboutOpen(true)}>
                    <span className="settingsShortcutIcon" aria-hidden="true"><InfoCircleOutlined /></span>
                    <span className="settingsShortcutCopy"><strong>关于版本</strong><small>查看版本、更新和运行环境</small></span>
                    <span className="settingsShortcutArrow" aria-hidden="true"><RightOutlined /></span>
                  </Button>
                </div>
              </section>

              <ProxyForm form={form} enabled={enabled} />
            </div>

            <div className="settingsModalFooter">
              <div className={`settingsFooterState ${enabled ? "is-enabled" : ""}`}>
                <CheckCircleOutlined />
                <span>{enabled ? "保存后，新连接将使用全局代理" : "保存后，应用将继续直接连接"}</span>
              </div>
              <div className="settingsFooterActions">
                <Button disabled={saving} onClick={close}>取消</Button>
                <Button type="primary" loading={saving} onClick={() => void submit()}>保存设置</Button>
              </div>
            </div>
          </main>
        </div>

        <AboutModal
          open={aboutOpen}
          onClose={() => setAboutOpen(false)}
          appInfo={appInfo}
          updateInfo={updateInfo}
          updateError={updateError}
          updateChecking={updateChecking}
          updateDownloading={updateDownloading}
          downloadedUpdatePath={downloadedUpdatePath}
          updateRepo={updateRepo}
          onCheckUpdate={onCheckUpdate}
          onDownloadUpdate={onDownloadUpdate}
          onInstallUpdate={onInstallUpdate}
          onOpenDatabaseDir={onOpenDatabaseDir}
          onOpenPathDir={onOpenPathDir}
          onOpenExternalUrl={onOpenExternalUrl}
          onShowReleaseNotes={() => setReleaseNotesOpen(true)}
        />

        <ReleaseNotesModal
          open={releaseNotesOpen}
          onClose={() => setReleaseNotesOpen(false)}
          updateInfo={updateInfo}
          updateDownloading={updateDownloading}
          onDownloadUpdate={onDownloadUpdate}
          onIgnoreUpdate={onIgnoreUpdate}
        />
      </Modal>

      <AiApiPanel
        open={aiApiOpen}
        onClose={() => onAiApiOpenChange(false)}
        initialValue={initialValue}
        sessions={sessions}
        onCreateSession={onCreateSession}
        onApiServerChange={onApiServerChange}
        onSettingsChange={onSettingsChange}
      />
    </>
  );
}
