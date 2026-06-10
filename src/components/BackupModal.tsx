import { CloudUploadOutlined, DeleteOutlined, ExportOutlined, FolderOpenOutlined, ImportOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { App as AntdApp, Button, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo } from "react";
import type { AppSettings, BackupRecord, BackupSettings } from "../types";
import { defaultBackupSettings } from "../api/vaultApi";
import { getErrorMessage } from "../lib/configMapping";
import { formatBeijingCompactTimestamp, formatBeijingDateTime, formatBytes } from "../lib/format";

interface BackupModalProps {
  open: boolean;
  busy: boolean;
  settings: AppSettings;
  records: BackupRecord[];
  onClose: () => void;
  onExport: (path: string) => Promise<void>;
  onImport: (path: string) => Promise<void>;
  onSettingsSave: (settings: AppSettings) => Promise<void>;
  onRunNow: () => Promise<void>;
  onRestoreRecord: (recordId: string) => Promise<void>;
  onDeleteRecord: (recordId: string, deleteFile: boolean) => Promise<void>;
}

type BackupTarget = "local" | "cloud";
type BackupFormValues = BackupSettings & { targetKind: BackupTarget };
type PartialCloudBackupSettings = Partial<BackupSettings["cloud"]> & {
  webdav?: Partial<BackupSettings["cloud"]["webdav"]>;
  s3?: Partial<BackupSettings["cloud"]["s3"]>;
};
type PartialBackupSettings = Partial<BackupSettings> & { cloud?: PartialCloudBackupSettings };

export function BackupModal({
  open,
  busy,
  settings,
  records,
  onClose,
  onExport,
  onImport,
  onSettingsSave,
  onRunNow,
  onRestoreRecord,
  onDeleteRecord,
}: BackupModalProps) {
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<BackupFormValues>();
  const backupTarget = Form.useWatch("targetKind", form) ?? "local";
  const cloudKind = Form.useWatch(["cloud", "kind"], form);
  const activeCloudKind = cloudKind === "s3" ? "s3" : "webdav";
  const isCloudTarget = backupTarget === "cloud";

  useEffect(() => {
    if (!open) return;
    const backup = normalizeBackupSettingsForForm(settings.backup);
    form.setFieldsValue({
      ...backup,
      targetKind: backup.localDirectory ? "local" : isCloudBackupConfigured(backup.cloud) ? "cloud" : "local",
    });
  }, [form, open, settings.backup]);

  async function chooseExportPath() {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        title: "导出备份",
        defaultPath: `HelM-backup-${formatBeijingCompactTimestamp()}-BJT.zip`,
        filters: [{ name: "HelM 备份包", extensions: ["zip"] }],
      });
      if (!path) return;
      await onExport(path);
      message.success("备份已导出");
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  async function chooseImportPath() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        title: "选择备份",
        multiple: false,
        filters: [{ name: "HelM 备份", extensions: ["zip", "rpvault"] }],
      });
      if (typeof path !== "string" || !path) return;
      modal.confirm({
        title: "恢复备份",
        content: "恢复会断开当前所有连接，并用备份覆盖本机数据。",
        okText: "恢复",
        cancelText: "取消",
        okButtonProps: { danger: true },
        onOk: async () => {
          await onImport(path);
          message.success("备份已恢复");
        },
      });
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  async function chooseLocalDirectory() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ title: "选择本地备份目录", directory: true, multiple: false });
      if (typeof path === "string" && path) {
        form.setFieldValue("localDirectory", path);
      }
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  function setCloudKind(kind: "webdav" | "s3") {
    form.setFieldValue(["cloud", "kind"], kind);
  }

  async function saveBackupSettings() {
    try {
      const backupValues = normalizeBackupSettingsForForm(await form.validateFields());
      const localDirectory = backupValues.localDirectory?.trim() || null;
      const cloud = normalizeCloudBackupKindForSave(backupValues.cloud);
      ensureCloudBackupReady(cloud, isCloudTarget);
      form.setFieldValue(["cloud", "kind"], cloud.kind);
      await onSettingsSave({
        ...settings,
        backup: {
          ...backupValues,
          localDirectory,
          retentionCount: backupValues.retentionCount || 10,
          retentionDays: backupValues.retentionDays || 30,
          cloud: {
            ...cloud,
            enabled: isCloudBackupConfigured(cloud),
          },
        },
      });
      message.success("备份设置已保存");
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  async function runBackupNow() {
    try {
      await onRunNow();
      message.success("备份已完成");
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  function restoreRecord(record: BackupRecord) {
    modal.confirm({
      title: "恢复此备份",
      content: `将恢复 ${record.fileName}，并断开当前所有连接。`,
      okText: "恢复",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        await onRestoreRecord(record.id);
        message.success("备份已恢复");
      },
    });
  }

  const columns: ColumnsType<BackupRecord> = [
    { title: "时间", width: 150, render: (_, record) => formatBeijingDateTime(record.createdAt) },
    { title: "文件", dataIndex: "fileName", ellipsis: true },
    { title: "路径", dataIndex: "targetPath", ellipsis: true },
    { title: "大小", width: 90, render: (_, record) => formatBytes(record.size, { zeroText: "-" }) },
    {
      title: "状态",
      width: 92,
      render: (_, record) => {
        const isSuccess = record.status === "success";
        return (
          <span className={`tunnelStatusBadge ${isSuccess ? "tunnelStatusBadge-running" : "tunnelStatusBadge-stopped"}`}>
            {isSuccess ? "成功" : "失败"}
          </span>
        );
      },
    },
    {
      title: "",
      width: 92,
      render: (_, record) => (
        <Space size={4} onMouseEnter={(e) => e.stopPropagation()}>
          <Tooltip title="恢复此备份" mouseEnterDelay={0.15}>
            <Button
              aria-label="恢复此备份"
              size="small"
              icon={<ImportOutlined />}
              disabled={record.status !== "success"}
              onClick={() => restoreRecord(record)}
            />
          </Tooltip>
          <Popconfirm
            title="删除备份记录"
            description={record.targetKind === "local" ? "同时删除本地备份文件。" : "仅删除记录，不会删除云端文件。"}
            okText="删除"
            cancelText="取消"
            onConfirm={() => void onDeleteRecord(record.id, record.targetKind === "local")}
          >
            <Tooltip title="删除备份记录" mouseEnterDelay={0.15}>
              <Button aria-label="删除备份记录" size="small" icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const tableComponents = useMemo(() => {
    const recordMap = new Map(records.map((item) => [item.id, item]));
    return {
      body: {
        row: (rowProps: React.HTMLAttributes<HTMLTableRowElement> & { "data-row-key"?: string }) => {
          const record = rowProps["data-row-key"] ? recordMap.get(rowProps["data-row-key"]) : undefined;
          if (!record) return <tr {...rowProps} />;
          return (
            <Tooltip
              mouseEnterDelay={0.4}
              placement="top"
              overlayClassName="backupRecordRowTooltip"
              getPopupContainer={(trigger) => trigger.closest(".ant-modal-body") || document.body}
              title={
                <div className="backupRecordRowTooltipContent">
                  <div><span>时间</span>{formatBeijingDateTime(record.createdAt)}</div>
                  <div><span>位置</span>{targetLabel(record.targetKind)}</div>
                  <div><span>文件</span>{record.fileName}</div>
                  <div><span>路径</span>{record.targetPath}</div>
                  <div><span>大小</span>{formatBytes(record.size, { zeroText: "-" })}</div>
                  <div><span>状态</span>{record.status === "success" ? "成功" : "失败"}</div>
                </div>
              }
            >
              <tr {...rowProps} />
            </Tooltip>
          );
        },
      },
    };
  }, [records]);

  return (
    <Modal
      open={open}
      title="数据备份"
      className="backupModal"
      footer={null}
      onCancel={onClose}
      destroyOnHidden
      width={760}
    >
      <Form form={form} layout="vertical" requiredMark={false} initialValues={settings.backup}>
        <div className="backupSimpleLayout">
          <section className="backupPanel backupPanel-actions">
            <div className="backupSectionHeader">
              <span>备份操作</span>
            </div>
            <div className="backupActionGrid">
              <Button icon={<ExportOutlined />} loading={busy} onClick={() => void chooseExportPath()}>
                导出备份
              </Button>
              <Button type="primary" icon={<PlayCircleOutlined />} loading={busy} onClick={() => void runBackupNow()}>
                立即备份
              </Button>
              <Button danger icon={<ImportOutlined />} loading={busy} onClick={() => void chooseImportPath()}>
                恢复备份
              </Button>
            </div>
          </section>

          <section className="backupPanel">
            <div className="backupSectionHeader">
              <span>备份设置</span>
              <Space size={10}>
                <Form.Item name="targetKind" noStyle rules={[{ required: true }]}>
                  <Segmented
                    size="small"
                    options={[
                      { label: "本地", value: "local" },
                      { label: "云端", value: "cloud" },
                    ]}
                  />
                </Form.Item>
                <Button type="primary" size="small" onClick={() => void saveBackupSettings()}>
                  保存配置
                </Button>
              </Space>
            </div>
            <div className="backupFormGrid backupFormGrid-tight">
              {isCloudTarget ? (
                <Form.Item label="自动备份" name={["cloud", "autoEnabled"]} valuePropName="checked">
                  <Switch />
                </Form.Item>
              ) : (
                <Form.Item label="自动备份" name="autoEnabled" valuePropName="checked">
                  <Switch />
                </Form.Item>
              )}
              <Form.Item label="频率" name="frequency">
                <Select
                  options={[
                    { label: "手动", value: "manual" },
                    { label: "每小时", value: "hourly" },
                    { label: "每天", value: "daily" },
                    { label: "每周", value: "weekly" },
                  ]}
                />
              </Form.Item>
              <Form.Item label="保留份数" name="retentionCount" rules={[{ required: true, message: "请输入保留份数" }]}>
                <InputNumber min={1} max={999} precision={0} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="保留天数" name="retentionDays" rules={[{ required: true, message: "请输入保留天数" }]}>
                <InputNumber min={1} max={3650} precision={0} style={{ width: "100%" }} />
              </Form.Item>
            </div>
            {backupTarget === "local" && (
              <Form.Item label="本地备份目录">
                <Form.Item name="localDirectory" noStyle rules={[{ required: true, message: "请选择本地备份目录" }]}>
                  <Input
                    className="privateKeyPathInput"
                    placeholder="选择一个目录保存备份包"
                    suffix={
                      <Tooltip title="选择本地备份目录">
                        <Button
                          type="text"
                          aria-label="选择本地备份目录"
                          className="privateKeyBrowseButton"
                          icon={<FolderOpenOutlined />}
                          onClick={() => void chooseLocalDirectory()}
                        />
                      </Tooltip>
                    }
                  />
                </Form.Item>
              </Form.Item>
            )}
          </section>

          {isCloudTarget && (
            <section className="backupPanel">
              <div className="backupCloudHeader">
                <Space>
                  <CloudUploadOutlined />
                  <span>云端备份</span>
                </Space>
                <Form.Item name={["cloud", "kind"]} hidden>
                  <Input />
                </Form.Item>
                <div className="backupCloudKindSwitch" data-kind={activeCloudKind} role="radiogroup" aria-label="云端备份类型">
                  <span className="backupCloudKindThumb" aria-hidden="true" />
                  <button
                    type="button"
                    className="backupCloudKindOption"
                    role="radio"
                    aria-checked={activeCloudKind === "webdav"}
                    onClick={() => setCloudKind("webdav")}
                  >
                    WebDAV
                  </button>
                  <button
                    type="button"
                    className="backupCloudKindOption"
                    role="radio"
                    aria-checked={activeCloudKind === "s3"}
                    onClick={() => setCloudKind("s3")}
                  >
                    S3 存储桶
                  </button>
                </div>
              </div>
              {activeCloudKind === "s3" ? (
                <div className="backupFormGrid">
                  <Form.Item label="Endpoint" name={["cloud", "s3", "endpoint"]}>
                    <Input placeholder="https://s3.amazonaws.com" />
                  </Form.Item>
                  <Form.Item label="Region" name={["cloud", "s3", "region"]}>
                    <Input placeholder="AWS: us-east-1；R2: auto" />
                  </Form.Item>
                  <Form.Item label="Access Key ID" name={["cloud", "s3", "accessKeyId"]}>
                    <Input />
                  </Form.Item>
                  <Form.Item label="Secret Access Key" name={["cloud", "s3", "secretAccessKey"]}>
                    <Input.Password />
                  </Form.Item>
                  <Form.Item label="Bucket" name={["cloud", "s3", "bucket"]}>
                    <Input />
                  </Form.Item>
                  <Form.Item label="Path" name={["cloud", "s3", "prefix"]}>
                    <Input placeholder="helm" />
                  </Form.Item>
                  <Form.Item label="路径样式" name={["cloud", "s3", "pathStyle"]} valuePropName="checked">
                    <Tooltip title="开启：使用 https://endpoint/bucket/object。关闭：使用 https://bucket.endpoint/object。AWS S3 建议关闭；Cloudflare R2 通常保持关闭；MinIO、自建或部分兼容 S3 服务如果连接失败可开启。">
                      <Switch />
                    </Tooltip>
                  </Form.Item>
                </div>
              ) : (
                <div className="backupFormGrid">
                  <Form.Item label="WebDAV 地址" name={["cloud", "webdav", "endpoint"]}>
                    <Input placeholder="https://example.com/dav" />
                  </Form.Item>
                  <Form.Item label="远端目录" name={["cloud", "webdav", "remotePath"]}>
                    <Input placeholder="helm" />
                  </Form.Item>
                  <Form.Item label="用户名" name={["cloud", "webdav", "username"]}>
                    <Input />
                  </Form.Item>
                  <Form.Item label="密码" name={["cloud", "webdav", "password"]}>
                    <Input.Password />
                  </Form.Item>
                </div>
              )}
            </section>
          )}

          <section className="backupPanel">
            <div className="backupSectionHeader">
              <span>{backupTarget === "local" ? "本地备份" : "云端备份"}</span>
              <Tag>{records.filter((r) => backupTarget === "local" ? r.targetKind === "local" : r.targetKind !== "local").length}</Tag>
            </div>
            <Table
              className="backupRecordTable"
              rowKey="id"
              size="small"
              columns={columns}
              dataSource={records.filter((r) => backupTarget === "local" ? r.targetKind === "local" : r.targetKind !== "local")}
              components={tableComponents}
              pagination={{ pageSize: 5, hideOnSinglePage: true }}
              scroll={{ x: 720, y: 180 }}
            />
          </section>
        </div>
      </Form>
    </Modal>
  );
}

function targetLabel(kind: BackupRecord["targetKind"]) {
  if (kind === "local") return "本地";
  if (kind === "webdav") return "WebDAV";
  if (kind === "s3") return "S3";
  return "云端";
}

function normalizeBackupSettingsForForm(settings?: PartialBackupSettings | null): BackupSettings {
  const defaults = defaultBackupSettings();
  return {
    ...defaults,
    ...settings,
    localDirectory: settings?.localDirectory ?? null,
    cloud: {
      ...defaults.cloud,
      ...settings?.cloud,
      autoEnabled: settings?.cloud?.autoEnabled ?? defaults.cloud.autoEnabled,
      webdav: {
        ...defaults.cloud.webdav,
        ...settings?.cloud?.webdav,
      },
      s3: {
        ...defaults.cloud.s3,
        ...settings?.cloud?.s3,
      },
    },
  };
}

function normalizeCloudBackupKindForSave(cloud: BackupSettings["cloud"]): BackupSettings["cloud"] {
  const webdavConfigured = isWebdavBackupConfigured(cloud.webdav);
  const s3Configured = isS3BackupConfigured(cloud.s3);
  const kind = cloud.kind === "s3" ? "s3" : "webdav";
  if (kind === "webdav" && !webdavConfigured && s3Configured) {
    return { ...cloud, kind: "s3" };
  }
  if (kind === "s3" && !s3Configured && webdavConfigured) {
    return { ...cloud, kind: "webdav" };
  }
  return { ...cloud, kind };
}

function ensureCloudBackupReady(cloud: BackupSettings["cloud"], cloudTargetVisible: boolean) {
  if (isCloudBackupConfigured(cloud)) return;
  if (!cloudTargetVisible && !cloud.autoEnabled) return;
  if (cloud.kind === "webdav") {
    throw new Error("请先填写 WebDAV 地址，或切换到已配置的 S3");
  }
  throw new Error("请先完整填写 S3 的 Endpoint、Region、Bucket、Access Key ID 和 Secret Access Key，或切换到已配置的 WebDAV");
}

function isCloudBackupConfigured(cloud?: BackupSettings["cloud"]) {
  if (!cloud) return false;
  if (cloud.kind === "webdav") {
    return isWebdavBackupConfigured(cloud.webdav);
  }
  return isS3BackupConfigured(cloud.s3);
}

function isWebdavBackupConfigured(webdav: BackupSettings["cloud"]["webdav"]) {
  return webdav.endpoint.trim().length > 0;
}

function isS3BackupConfigured(s3: BackupSettings["cloud"]["s3"]) {
  return (
    s3.endpoint.trim().length > 0 &&
    s3.region.trim().length > 0 &&
    s3.bucket.trim().length > 0 &&
    s3.accessKeyId.trim().length > 0 &&
    s3.secretAccessKey.trim().length > 0
  );
}
