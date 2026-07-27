import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  ImportOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { App as AntdApp, Button, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Switch, Tooltip } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { AppSettings, BackupRecord, BackupSettings } from "../types";
import { defaultBackupSettings } from "../api/vaultApi";
import { getErrorMessage } from "../lib/configMapping";
import { formatBeijingCompactTimestamp, formatBeijingDateTime, formatBeijingMonthDayTime, formatBytes } from "../lib/format";
import { useMountedRef } from "../lib/reactLifecycle";

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
type BackupRecordStatusFilter = "all" | BackupRecord["status"];
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
  const normalizedSettings = useMemo(() => normalizeBackupSettingsForForm(settings.backup), [settings.backup]);
  const defaultTarget: BackupTarget = normalizedSettings.localDirectory
    ? "local"
    : isCloudBackupConfigured(normalizedSettings.cloud)
      ? "cloud"
      : "local";
  const backupTarget = Form.useWatch("targetKind", form) ?? defaultTarget;
  const cloudKind = Form.useWatch(["cloud", "kind"], form);
  const watchedFrequency = Form.useWatch("frequency", form) ?? normalizedSettings.frequency;
  const watchedLocalAutoEnabled = Form.useWatch("autoEnabled", form) ?? normalizedSettings.autoEnabled;
  const watchedLocalDirectory = Form.useWatch("localDirectory", form) ?? normalizedSettings.localDirectory;
  const watchedCloudValue = Form.useWatch("cloud", form);
  const watchedCloud = useMemo<BackupSettings["cloud"]>(() => {
    const cloud = watchedCloudValue ?? normalizedSettings.cloud;
    return {
      ...normalizedSettings.cloud,
      ...cloud,
      webdav: {
        ...normalizedSettings.cloud.webdav,
        ...(cloud.webdav ?? {}),
      },
      s3: {
        ...normalizedSettings.cloud.s3,
        ...(cloud.s3 ?? {}),
      },
    };
  }, [normalizedSettings.cloud, watchedCloudValue]);
  const activeCloudKind = cloudKind === "s3" ? "s3" : cloudKind === "webdav" ? "webdav" : normalizedSettings.cloud.kind;
  const isCloudTarget = backupTarget === "cloud";
  const activeAutoEnabled = Boolean(isCloudTarget ? watchedCloud.autoEnabled : watchedLocalAutoEnabled);
  const activeCloudConfigured = activeCloudKind === "s3"
    ? isS3BackupConfigured(watchedCloud.s3)
    : isWebdavBackupConfigured(watchedCloud.webdav);
  const activeTargetConfigured = isCloudTarget ? activeCloudConfigured : Boolean(watchedLocalDirectory?.trim());
  const mountedRef = useMountedRef();
  const [savingSettings, setSavingSettings] = useState(false);
  const [recordQuery, setRecordQuery] = useState("");
  const [recordStatusFilter, setRecordStatusFilter] = useState<BackupRecordStatusFilter>("all");

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      ...normalizedSettings,
      targetKind: defaultTarget,
    });
    setRecordQuery("");
    setRecordStatusFilter("all");
  }, [defaultTarget, form, normalizedSettings, open]);

  useEffect(() => {
    if (!open) return;
    setRecordQuery("");
    setRecordStatusFilter("all");
  }, [backupTarget, open]);

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
      if (mountedRef.current) message.success("备份已导出");
    } catch (error) {
      if (mountedRef.current) message.error(getErrorMessage(error));
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
          if (mountedRef.current) message.success("备份已恢复");
        },
      });
    } catch (error) {
      if (mountedRef.current) message.error(getErrorMessage(error));
    }
  }

  async function chooseLocalDirectory() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ title: "选择本地备份目录", directory: true, multiple: false });
      if (typeof path === "string" && path) {
        if (mountedRef.current) form.setFieldValue("localDirectory", path);
      }
    } catch (error) {
      if (mountedRef.current) message.error(getErrorMessage(error));
    }
  }

  function setCloudKind(kind: "webdav" | "s3") {
    const currentCloud = form.getFieldValue("cloud");
    form.setFieldsValue({
      cloud: {
        ...normalizedSettings.cloud,
        ...currentCloud,
        kind,
        webdav: {
          ...normalizedSettings.cloud.webdav,
          ...(currentCloud?.webdav ?? {}),
        },
        s3: {
          ...normalizedSettings.cloud.s3,
          ...(currentCloud?.s3 ?? {}),
        },
      },
    });
  }

  async function saveBackupSettings() {
    setSavingSettings(true);
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
      if (mountedRef.current) message.success("备份设置已保存");
    } catch (error) {
      if (mountedRef.current) message.error(getErrorMessage(error));
    } finally {
      if (mountedRef.current) setSavingSettings(false);
    }
  }

  async function runBackupNow() {
    try {
      await onRunNow();
      if (mountedRef.current) message.success("备份已完成");
    } catch (error) {
      if (mountedRef.current) message.error(getErrorMessage(error));
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
        if (mountedRef.current) message.success("备份已恢复");
      },
    });
  }

  const targetRecords = useMemo(
    () => records
      .filter((record) => (backupTarget === "local" ? record.targetKind === "local" : record.targetKind !== "local"))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    [backupTarget, records],
  );
  const filteredRecords = useMemo(() => {
    const normalizedQuery = recordQuery.trim().toLocaleLowerCase();
    return targetRecords.filter((record) => {
      if (recordStatusFilter !== "all" && record.status !== recordStatusFilter) return false;
      if (!normalizedQuery) return true;
      return record.fileName.toLocaleLowerCase().includes(normalizedQuery)
        || record.targetPath.toLocaleLowerCase().includes(normalizedQuery);
    });
  }, [recordQuery, recordStatusFilter, targetRecords]);
  const latestTargetRecord = targetRecords[0];
  const targetTotalSize = targetRecords.reduce((total, record) => total + Math.max(0, record.size), 0);
  const frequencyText = backupFrequencyLabel(watchedFrequency);
  const latestBackupText = latestTargetRecord
    ? formatBeijingMonthDayTime(latestTargetRecord.createdAt, "时间未知")
    : "暂无记录";
  const nextBackupText = nextBackupRunLabel(latestTargetRecord?.createdAt, watchedFrequency, activeAutoEnabled);
  const selectedTargetText = isCloudTarget ? cloudKindLabel(activeCloudKind) : "本地";
  const healthState = busy
    ? "running"
    : !activeTargetConfigured
      ? "warning"
      : activeAutoEnabled && watchedFrequency !== "manual"
        ? "healthy"
        : "paused";
  const healthTitle = healthState === "running"
    ? "备份任务执行中"
    : healthState === "warning"
      ? isCloudTarget ? "云端参数待完成" : "尚未选择备份目录"
      : healthState === "healthy"
        ? "自动备份已开启"
        : "当前使用手动备份";
  const healthDetail = healthState === "running"
    ? "正在生成并写入备份包"
    : healthState === "warning"
      ? "完成配置后即可执行备份"
      : healthState === "healthy"
        ? `${frequencyText}执行，当前策略运行正常`
        : "需要时可使用下方快捷操作";
  const headerStatusText = healthState === "running"
    ? "正在备份"
    : healthState === "warning"
      ? "配置待完成"
      : healthState === "healthy"
        ? "备份服务正常"
        : "手动备份模式";

  function renderBackupRecordRow(record: BackupRecord) {
    const isSuccess = record.status === "success";
    return (
      <Tooltip
        key={record.id}
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
            <div><span>状态</span>{isSuccess ? "成功" : "失败"}</div>
          </div>
        }
      >
        <tr className="backupRecordTableRow">
          <td className="backupRecordFileCell">
            <strong title={record.fileName}>{record.fileName}</strong>
            <span title={record.targetPath}>{targetLabel(record.targetKind)} · {record.targetPath}</span>
          </td>
          <td>{formatBeijingDateTime(record.createdAt)}</td>
          <td>{formatBytes(record.size, { zeroText: "-" })}</td>
          <td>
            <span className={`backupRecordStatus ${isSuccess ? "is-success" : "is-failed"}`}>
              {isSuccess ? "成功" : "失败"}
            </span>
          </td>
          <td>
            <div className="backupRecordActions" onMouseEnter={(event) => event.stopPropagation()}>
              <Tooltip title="恢复此备份" mouseEnterDelay={0.15}>
                <Button
                  aria-label="恢复此备份"
                  size="small"
                  className="backupRecordActionButton"
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
                  <Button
                    aria-label="删除备份记录"
                    size="small"
                    className="backupRecordActionButton is-danger"
                    icon={<DeleteOutlined />}
                  />
                </Tooltip>
              </Popconfirm>
            </div>
          </td>
        </tr>
      </Tooltip>
    );
  }

  return (
    <Modal
      open={open}
      title={
        <div className="backupModalHeader">
          <div className="backupModalHeaderIcon" aria-hidden="true">
            <DatabaseOutlined />
          </div>
          <div className="backupModalHeaderCopy">
            <strong>数据备份</strong>
            <span>管理自动备份策略、导出备份包与恢复点</span>
          </div>
          <div className={`backupModalHeaderStatus is-${healthState}`} aria-live="polite">
            {healthState === "warning" ? <WarningOutlined /> : <CheckCircleOutlined />}
            <span>{headerStatusText}</span>
          </div>
        </div>
      }
      className="backupModal"
      footer={null}
      onCancel={onClose}
      destroyOnHidden
      centered
      transitionName="helm-modal-motion"
      maskTransitionName="helm-mask-motion"
      width={1120}
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        className="backupForm"
        initialValues={{ ...normalizedSettings, targetKind: defaultTarget }}
      >
        <div className="backupLayout">
          <aside className="backupSidebar">
            <div className="backupSidebarLabel">备份概览</div>

            <div className={`backupHealthCard is-${healthState}`}>
              <div className="backupHealthCardHead">
                <span className="backupHealthIcon" aria-hidden="true">
                  {healthState === "warning"
                    ? <WarningOutlined />
                    : healthState === "running"
                      ? <CloudUploadOutlined />
                      : <CheckCircleOutlined />}
                </span>
                <div>
                  <strong>{healthTitle}</strong>
                  <span>{healthDetail}</span>
                </div>
              </div>
              <div className="backupHealthDivider" />
              <div className="backupHealthRow"><span>最近备份</span><strong>{latestBackupText}</strong></div>
              <div className="backupHealthRow"><span>下次执行</span><strong>{nextBackupText}</strong></div>
              <div className="backupHealthRow"><span>当前目标</span><strong>{selectedTargetText}</strong></div>
            </div>

            <div className="backupMetricGrid">
              <div className="backupMetricCard">
                <span>{selectedTargetText}恢复点</span>
                <strong>{targetRecords.length} 份</strong>
              </div>
              <div className="backupMetricCard">
                <span>占用空间</span>
                <strong>{formatBytes(targetTotalSize, { zeroText: "0 B" })}</strong>
              </div>
            </div>

            <div className="backupSidebarLabel">快捷操作</div>
            <div className="backupQuickActions">
              <Button
                block
                type="primary"
                className="backupQuickAction is-primary"
                icon={<PlayCircleOutlined />}
                loading={busy}
                onClick={() => void runBackupNow()}
              >
                立即创建备份
              </Button>
              <Button
                block
                className="backupQuickAction"
                icon={<ExportOutlined />}
                loading={busy}
                onClick={() => void chooseExportPath()}
              >
                导出备份包
              </Button>
              <Button
                block
                danger
                className="backupQuickAction is-danger"
                icon={<ImportOutlined />}
                loading={busy}
                onClick={() => void chooseImportPath()}
              >
                从文件恢复
              </Button>
            </div>

            <div className="backupSecurityNote">
              <span aria-hidden="true"><SafetyCertificateOutlined /></span>
              <p>备份包仅保存在所选位置，执行恢复前会要求二次确认。</p>
            </div>
          </aside>

          <main className="backupMain">
            <div className="backupTargetToolbar">
              <div className="backupTargetCopy">
                <strong>备份目标</strong>
                <span>切换后显示对应位置的策略、参数与恢复点</span>
              </div>
              <Form.Item name="targetKind" noStyle rules={[{ required: true }]}>
                <Segmented
                  block
                  className="backupTargetSegmented"
                  options={[
                    { label: "本地备份", value: "local" },
                    { label: "云端备份", value: "cloud" },
                  ]}
                />
              </Form.Item>
            </div>

            <section className="backupContentCard backupStrategyCard">
              <div className="backupContentCardHeader">
                <div>
                  <strong>备份策略</strong>
                  <span>设置自动执行频率与恢复点保留规则</span>
                </div>
                <Button
                  type="primary"
                  size="small"
                  className="backupSaveButton"
                  loading={savingSettings}
                  disabled={busy}
                  onClick={() => void saveBackupSettings()}
                >
                  保存配置
                </Button>
              </div>

              <div className="backupStrategyGrid">
                <div className="backupAutoField">
                  <span className="backupStandaloneLabel">自动备份</span>
                  <div className="backupAutoControl">
                    <Form.Item
                      key={backupTarget}
                      name={isCloudTarget ? ["cloud", "autoEnabled"] : "autoEnabled"}
                      valuePropName="checked"
                      noStyle
                    >
                      <Switch />
                    </Form.Item>
                    <span>{activeAutoEnabled ? "已启用" : "未启用"}</span>
                  </div>
                </div>
                <Form.Item label="执行频率" name="frequency">
                  <Select
                    options={[
                      { label: "手动执行", value: "manual" },
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
                {!isCloudTarget && (
                  <Form.Item
                    className="backupDirectoryField"
                    label={
                      <span className="backupDirectoryLabel">
                        <span>本地备份目录</span>
                        <small>备份包将写入此位置</small>
                      </span>
                    }
                  >
                    <Form.Item name="localDirectory" noStyle rules={[{ required: true, message: "请选择本地备份目录" }]}>
                      <Input
                        className="backupDirectoryInput"
                        placeholder="选择一个目录保存备份包"
                        suffix={
                          <Tooltip title="选择本地备份目录">
                            <Button
                              type="text"
                              aria-label="选择本地备份目录"
                              className="backupBrowseButton"
                              icon={<FolderOpenOutlined />}
                              onClick={() => void chooseLocalDirectory()}
                            />
                          </Tooltip>
                        }
                      />
                    </Form.Item>
                  </Form.Item>
                )}
              </div>
            </section>

            {isCloudTarget && (
              <section className="backupContentCard backupCloudCard">
                <div className="backupCloudCardHeader">
                  <div className="backupCloudCardTitle">
                    <span aria-hidden="true"><CloudUploadOutlined /></span>
                    <div>
                      <strong>云端连接</strong>
                      <small>凭证会加密保存在本机</small>
                    </div>
                  </div>
                  <div className="backupCloudCardActions">
                    <span className={`backupCloudReadyState${activeCloudConfigured ? " is-ready" : ""}`}>
                      {activeCloudConfigured ? "参数完整" : "参数待完成"}
                    </span>
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
                </div>

                {activeCloudKind === "s3" ? (
                  <div className="backupCloudFields is-s3">
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
                    <Form.Item label="远端目录" name={["cloud", "s3", "prefix"]}>
                      <Input placeholder="helm" />
                    </Form.Item>
                    <div className="backupPathStyleField">
                      <div>
                        <strong>路径样式</strong>
                        <span>MinIO 或部分兼容服务连接失败时可开启</span>
                      </div>
                      <Form.Item name={["cloud", "s3", "pathStyle"]} valuePropName="checked" noStyle>
                        <Switch />
                      </Form.Item>
                    </div>
                  </div>
                ) : (
                  <div className="backupCloudFields">
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

            <section className="backupContentCard backupRecordsCard">
              <div className="backupRecordsHeader">
                <div className="backupRecordsTitle">
                  <strong>恢复点</strong>
                  <span>{targetRecords.length}</span>
                  {filteredRecords.length !== targetRecords.length && <small>显示 {filteredRecords.length} 条</small>}
                </div>
                <div className="backupRecordsToolbar">
                  <Input
                    allowClear
                    value={recordQuery}
                    prefix={<SearchOutlined />}
                    placeholder="搜索文件名或路径"
                    aria-label="搜索备份记录"
                    onChange={(event) => setRecordQuery(event.target.value)}
                  />
                  <Select<BackupRecordStatusFilter>
                    value={recordStatusFilter}
                    aria-label="筛选备份状态"
                    options={[
                      { label: "全部状态", value: "all" },
                      { label: "成功", value: "success" },
                      { label: "失败", value: "failed" },
                    ]}
                    onChange={setRecordStatusFilter}
                  />
                </div>
              </div>

              <div className="backupRecordTableFrame">
                <div className="backupRecordTableScroll">
                  <table className="backupRecordTable">
                    <BackupRecordColGroup />
                    <thead>
                      <tr>
                        <th>备份文件</th>
                        <th>创建时间</th>
                        <th>大小</th>
                        <th>状态</th>
                        <th aria-label="操作">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRecords.length > 0 ? (
                        filteredRecords.map(renderBackupRecordRow)
                      ) : (
                        <tr className="backupRecordTableEmptyRow">
                          <td colSpan={5}>
                            {targetRecords.length > 0 ? "没有符合筛选条件的恢复点" : `暂无${selectedTargetText}备份记录`}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </main>
        </div>
      </Form>
    </Modal>
  );
}

function BackupRecordColGroup() {
  return (
    <colgroup>
      <col className="backupRecordColFile" />
      <col className="backupRecordColTime" />
      <col className="backupRecordColSize" />
      <col className="backupRecordColStatus" />
      <col className="backupRecordColActions" />
    </colgroup>
  );
}

function backupFrequencyLabel(frequency: BackupSettings["frequency"]) {
  if (frequency === "hourly") return "每小时";
  if (frequency === "daily") return "每天";
  if (frequency === "weekly") return "每周";
  return "手动";
}

function nextBackupRunLabel(
  latestCreatedAt: string | undefined,
  frequency: BackupSettings["frequency"],
  enabled: boolean,
) {
  if (!enabled) return "未启用";
  if (frequency === "manual") return "手动执行";
  if (!latestCreatedAt) return "等待首次执行";
  const latestTime = Date.parse(latestCreatedAt);
  if (!Number.isFinite(latestTime)) return "按计划执行";
  const interval = frequency === "hourly"
    ? 60 * 60 * 1000
    : frequency === "daily"
      ? 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const elapsedIntervals = Math.max(1, Math.floor((now - latestTime) / interval) + 1);
  const nextTime = latestTime + elapsedIntervals * interval;
  return formatBeijingMonthDayTime(new Date(nextTime).toISOString(), "按计划执行");
}

function cloudKindLabel(kind: BackupSettings["cloud"]["kind"]) {
  return kind === "s3" ? "S3" : "WebDAV";
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

function isWebdavBackupConfigured(webdav?: BackupSettings["cloud"]["webdav"]) {
  return Boolean(webdav?.endpoint?.trim());
}

function isS3BackupConfigured(s3?: BackupSettings["cloud"]["s3"]) {
  return Boolean(
    s3?.endpoint?.trim() &&
    s3.region?.trim() &&
    s3.bucket?.trim() &&
    s3.accessKeyId?.trim() &&
    s3.secretAccessKey?.trim()
  );
}
