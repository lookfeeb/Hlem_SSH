import { ApartmentOutlined, ExportOutlined, InfoCircleOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Button, Form, Modal, Space } from "antd";
import { useEffect, useState } from "react";
import type { AppInfo, AppSettings, ConfigSnapshot, UpdateInfo } from "../types";

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
  open, initialValue, sessions, onClose, onSubmit, onBackupOpen, onTunnelOpen,
  onApiServerChange, onSettingsChange, aiApiOpen, onAiApiOpenChange,
  appInfo, updateInfo, updateError, updateChecking, updateDownloading,
  downloadedUpdatePath, updateRepo, onCheckUpdate, onDownloadUpdate, onInstallUpdate,
  onIgnoreUpdate, onOpenDatabaseDir, onOpenPathDir, onOpenExternalUrl,
}: SettingsModalProps) {
  const [form] = Form.useForm<SettingsFormValues>();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const enabled = Form.useWatch("enabled", form);

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
    const values = await form.validateFields();
    await onSubmit({
      ...initialValue,
      proxy: values.enabled ? { enabled: true, kind: values.kind, host: values.host.trim(), port: values.port } : null,
    });
  }

  return (
    <>
      <Modal open={open} title="全局设置" className="settingsModal" okText="保存" cancelText="取消" onOk={() => void submit()} onCancel={onClose} destroyOnHidden>
        <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          <div className="settingsPanel">
            <div className="settingsSectionTitle">数据与连接</div>
            <div className="settingsShortcutGrid">
              <Button block icon={<ExportOutlined />} onClick={onBackupOpen}>数据备份与恢复</Button>
              <Button block icon={<ApartmentOutlined />} onClick={onTunnelOpen}>SSH 隧道管理</Button>
              <Button block icon={<ThunderboltOutlined />} onClick={() => onAiApiOpenChange(true)}>AI API 控制</Button>
              <Button block icon={<InfoCircleOutlined />} onClick={() => setAboutOpen(true)}>关于版本</Button>
            </div>
          </div>
          <ProxyForm form={form} enabled={enabled} />
        </Space>

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
        onApiServerChange={onApiServerChange}
        onSettingsChange={onSettingsChange}
      />
    </>
  );
}
