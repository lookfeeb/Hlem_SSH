import {
  ClearOutlined,
  CloseOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { App as AntdApp, Button, Drawer, Empty, Progress, Space, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { appApi } from "../api/appApi";
import { getErrorMessage } from "../lib/configMapping";
import { formatBeijingDateTime, formatBytes } from "../lib/format";
import {
  backupKindText,
  backupStatusText,
  canRemoveTransfer,
  formatTransferSpeed,
  isActiveTransfer,
  isTransferDone,
  saveStatusText,
  transferName,
  transferProgressStatus,
  transferSourcePath,
  transferStatusText,
  transferStatusTone,
  transferTargetPath,
} from "../lib/transferRecords";
import type { BackupRecord, FileSaveRecord, RemoteSession, TransferInfo } from "../types";

type LocalPathExistsMap = Record<string, boolean | undefined>;
type TransferSessionLookup = {
  bySessionId: Map<string, RemoteSession>;
  bySftpId: Map<string, RemoteSession>;
};

interface TransferCenterProps {
  open: boolean;
  transfers: TransferInfo[];
  sessions: RemoteSession[];
  saveRecords: FileSaveRecord[];
  backupRecords: BackupRecord[];
  canUpload: boolean;
  onClose: () => void;
  onPause: (transferId: string) => void;
  onResume: (transferId: string) => void;
  onOpenDir: (path: string) => void;
  onCancel: (transferId: string) => void;
  onRetry: (transferId: string) => void;
  onRemove: (transferId: string) => void;
  onRetrySave: (recordId: string) => void;
  onRemoveSave: (recordId: string) => void;
  onRestoreBackup: (recordId: string) => Promise<void>;
  onRemoveBackup: (recordId: string) => Promise<void>;
  onClear: () => Promise<void> | void;
  onUploadFiles: (localPaths: string[]) => void;
}

export function TransferCenter({
  open,
  transfers,
  sessions,
  saveRecords,
  backupRecords,
  canUpload,
  onClose,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRemove,
  onRetrySave,
  onRemoveSave,
  onRestoreBackup,
  onRemoveBackup,
  onClear,
  onUploadFiles,
  onOpenDir,
}: TransferCenterProps) {
  const { message, modal } = AntdApp.useApp();
  const total = transfers.length + saveRecords.length + backupRecords.length;
  const [localPathExistsByTransferId, setLocalPathExistsByTransferId] = useState<LocalPathExistsMap>({});
  const [clearing, setClearing] = useState(false);
  const mountedRef = useRef(true);
  const openRef = useRef(open);
  const openCycleRef = useRef(0);
  if (openRef.current !== open) {
    openRef.current = open;
    openCycleRef.current += 1;
  }
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);
  useEffect(() => {
    if (!open) setClearing(false);
  }, [open]);
  const sessionLookup = useMemo<TransferSessionLookup>(() => {
    const bySessionId = new Map<string, RemoteSession>();
    const bySftpId = new Map<string, RemoteSession>();
    for (const session of sessions) {
      bySessionId.set(session.id, session);
      if (session.sftpId) bySftpId.set(session.sftpId, session);
    }
    return { bySessionId, bySftpId };
  }, [sessions]);
  const localPathCheckKey = useMemo(
    () =>
      transfers
        .filter(shouldCheckTransferLocalPath)
        .map((transfer) => [transfer.transferId, transfer.localPath, transfer.status, transfer.updatedAt].join("\u0000"))
        .join("\u0001"),
    [transfers],
  );

  useEffect(() => {
    let disposed = false;
    if (!open) {
      return () => {
        disposed = true;
      };
    }
    const targets = transfers
      .filter(shouldCheckTransferLocalPath)
      .map((transfer) => ({ transferId: transfer.transferId, localPath: transfer.localPath }));
    if (targets.length === 0) {
      setLocalPathExistsByTransferId({});
      return () => {
        disposed = true;
      };
    }
    void Promise.all(
      targets.map(async (target) => [target.transferId, await appApi.localPathExists(target.localPath)] as const),
    )
      .then((results) => {
        if (disposed) return;
        setLocalPathExistsByTransferId(Object.fromEntries(results));
      })
      .catch((error) => {
        console.warn("[helm] failed to check local transfer paths:", getErrorMessage(error));
        if (!disposed) setLocalPathExistsByTransferId({});
      });
    return () => {
      disposed = true;
    };
  }, [localPathCheckKey, open]);

  async function handleFileSelect() {
    const openCycle = openCycleRef.current;
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({ title: "选择上传文件", multiple: true });
      if (!mountedRef.current || !openRef.current || openCycleRef.current !== openCycle || !selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length > 0) onUploadFiles(paths);
    } catch (error) {
      if (mountedRef.current && openRef.current && openCycleRef.current === openCycle) {
        message.error(`选择上传文件失败：${getErrorMessage(error)}`);
      }
    }
  }

  async function handleClear() {
    if (clearing) return;
    const openCycle = openCycleRef.current;
    setClearing(true);
    try {
      await onClear();
    } catch (error) {
      if (mountedRef.current && openRef.current && openCycleRef.current === openCycle) {
        message.error(`清空任务记录失败：${getErrorMessage(error)}`);
      }
    } finally {
      if (mountedRef.current && openRef.current && openCycleRef.current === openCycle) {
        setClearing(false);
      }
    }
  }

  function restoreBackup(record: BackupRecord) {
    const openCycle = openCycleRef.current;
    modal.confirm({
      title: "恢复此备份",
      content: `将恢复 ${record.fileName}，并断开当前所有连接。`,
      okText: "恢复",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!openRef.current || openCycleRef.current !== openCycle) return;
        await onRestoreBackup(record.id);
        if (mountedRef.current && openRef.current && openCycleRef.current === openCycle) {
          message.success("备份已恢复");
        }
      },
    });
  }

  function removeBackup(record: BackupRecord) {
    const openCycle = openCycleRef.current;
    modal.confirm({
      title: "删除备份记录",
      content: "仅删除记录，不会删除备份文件。",
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!openRef.current || openCycleRef.current !== openCycle) return;
        await onRemoveBackup(record.id);
        if (mountedRef.current && openRef.current && openCycleRef.current === openCycle) {
          message.success("备份记录已删除");
        }
      },
    });
  }

  return (
    <Drawer
      open={open}
      title={`任务记录${total ? ` · ${total} 条` : ""}`}
      placement="right"
      size={430}
      closable={false}
      destroyOnHidden
      className="transferDrawer"
      extra={
        <Space size={4}>
          <Tooltip title="上传文件">
            <Button
              aria-label="上传文件"
              icon={<UploadOutlined />}
              size="small"
              type="text"
              disabled={!canUpload}
              onClick={() => void handleFileSelect()}
            />
          </Tooltip>
          <Tooltip title="清空记录">
            <Button
              aria-label="清空记录"
              icon={<ClearOutlined />}
              size="small"
              type="text"
              disabled={total === 0 || clearing}
              loading={clearing}
              onClick={() => void handleClear()}
            />
          </Tooltip>
          <Tooltip title="关闭">
            <Button
              aria-label="关闭"
              icon={<CloseOutlined />}
              size="small"
              type="text"
              onClick={onClose}
            />
          </Tooltip>
        </Space>
      }
      onClose={onClose}
    >
      {total === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务记录" />
      ) : (
        <div className="transferList">
          {renderAllRecords({
            transfers,
            saveRecords,
            backupRecords,
            detailPreviewEnabled: open,
            sessionLookup,
            localPathExistsByTransferId,
            onPause,
            onResume,
            onCancel,
            onRetry,
            onRemove,
            onRetrySave,
            onRemoveSave,
            onRestoreBackup: restoreBackup,
            onRemoveBackup: removeBackup,
            onOpenDir,
          })}
        </div>
      )}
    </Drawer>
  );
}

interface RenderAllRecordsProps {
  transfers: TransferInfo[];
  saveRecords: FileSaveRecord[];
  backupRecords: BackupRecord[];
  detailPreviewEnabled: boolean;
  sessionLookup: TransferSessionLookup;
  localPathExistsByTransferId: LocalPathExistsMap;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onOpenDir: (path: string) => void;
  onRetrySave: (id: string) => void;
  onRemoveSave: (id: string) => void;
  onRestoreBackup: (record: BackupRecord) => void;
  onRemoveBackup: (record: BackupRecord) => void;
}

type UnifiedRecord =
  | { type: "backup"; timestamp: number; record: BackupRecord }
  | { type: "save"; timestamp: number; record: FileSaveRecord }
  | { type: "transfer"; timestamp: number; record: TransferInfo };

function renderAllRecords(props: RenderAllRecordsProps) {
  const unified: UnifiedRecord[] = [];

  for (const record of props.backupRecords) {
    unified.push({ type: "backup", timestamp: new Date(record.createdAt).getTime() || 0, record });
  }
  for (const record of props.saveRecords) {
    unified.push({ type: "save", timestamp: new Date(record.savedAt).getTime() || 0, record });
  }
  for (const record of props.transfers) {
    unified.push({ type: "transfer", timestamp: new Date(record.createdAt).getTime() || 0, record });
  }

  // Active transfers first, then sort by time descending
  unified.sort((a, b) => {
    const aActive = isActiveRecord(a);
    const bActive = isActiveRecord(b);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.timestamp - a.timestamp;
  });

  return unified.map((item) => {
    switch (item.type) {
      case "backup":
        return renderBackupRecord(item.record, props);
      case "save":
        return renderSaveRecord(item.record, props);
      case "transfer":
        return renderTransferRecord(item.record, props);
    }
  });
}

function isActiveRecord(item: UnifiedRecord): boolean {
  if (item.type === "transfer") {
    return isActiveTransfer(item.record);
  }
  if (item.type === "save") {
    return item.record.status === "saving";
  }
  return false;
}

function renderBackupRecord(record: BackupRecord, props: RenderAllRecordsProps) {
  const restorable = record.status === "success";
  return (
    <article className="transferListItem backupRecordItem" key={`backup-${record.id}`}>
      <div className="transferListHeader">
        <div className="transferListTitle">
          <strong title={record.fileName}>{record.fileName}</strong>
          <span>
            {backupKindText(record.targetKind)} 备份 ·{" "}
            <span className={`saveRecordInlineStatus saveRecordInlineStatus-${record.status}`}>
              {backupStatusText(record.status)}
            </span>
          </span>
        </div>
        <Space size={4}>
          {restorable && (
            <Tooltip title="恢复此备份">
              <Button
                aria-label="恢复备份"
                icon={<ReloadOutlined />}
                size="small"
                onClick={() => props.onRestoreBackup(record)}
              />
            </Tooltip>
          )}
          <Tooltip title="删除记录">
            <Button
              aria-label="删除备份记录"
              icon={<DeleteOutlined />}
              size="small"
              onClick={() => props.onRemoveBackup(record)}
            />
          </Tooltip>
        </Space>
      </div>
      <div className="transferListPaths">
        <span title={record.targetPath}>位置：{record.targetPath}</span>
        <span>大小：{formatBytes(record.size)}</span>
        <span>时间：{formatBeijingDateTime(record.createdAt)}</span>
      </div>
      {record.error && <div className="transferListError">{record.error}</div>}
    </article>
  );
}

function renderSaveRecord(record: FileSaveRecord, props: RenderAllRecordsProps) {
  const retryable = record.status === "failed";
  const removable = record.status !== "saving";
  return (
    <article className="transferListItem saveRecordItem" key={`save-${record.id}`}>
      <div className="transferListHeader">
        <div className="transferListTitle">
          <strong title={record.path}>{record.name}</strong>
          <span>
            编辑保存 · <span className={`saveRecordInlineStatus saveRecordInlineStatus-${record.status}`}>{saveStatusText(record.status)}</span>
          </span>
        </div>
        <Space size={4}>
          {retryable && (
            <Tooltip title="重试保存">
              <Button
                aria-label="重试保存"
                icon={<ReloadOutlined />}
                size="small"
                onClick={() => props.onRetrySave(record.id)}
              />
            </Tooltip>
          )}
          {removable && (
            <Tooltip title="删除记录">
              <Button
                aria-label="删除保存记录"
                icon={<DeleteOutlined />}
                size="small"
                onClick={() => props.onRemoveSave(record.id)}
              />
            </Tooltip>
          )}
        </Space>
      </div>
      <div className="transferListPaths">
        <span title={record.directory}>目录：{record.directory}</span>
        <span>时间：{formatBeijingDateTime(record.savedAt)}</span>
      </div>
      {record.error && <div className="transferListError">{record.error}</div>}
    </article>
  );
}

function renderTransferRecord(transfer: TransferInfo, props: RenderAllRecordsProps) {
  const percent = transfer.bytesTotal
    ? Math.min(100, Math.round((transfer.bytesDone / transfer.bytesTotal) * 100))
    : 0;
  const running = transfer.status === "queued" || transfer.status === "running";
  const paused = transfer.status === "paused";
  const retryable = transfer.status === "failed" || transfer.status === "canceled";
  const targetSession = sessionForTransfer(transfer, props.sessionLookup);
  const targetConnected = Boolean(targetSession?.state === "connected" && targetSession.sftpId);
  const localMissing =
    shouldCheckTransferLocalPath(transfer) && props.localPathExistsByTransferId[transfer.transferId] === false;
  const retryDisabled = retryable && (!targetConnected || (transfer.direction === "upload" && localMissing));
  const retryTitle = retryDisabled
    ? localMissing && transfer.direction === "upload"
      ? "本地文件不存在"
      : "目标终端未连接"
    : transfer.direction === "upload" ? "重试上传" : "重新下载";
  const detailTooltip = transferDetailTooltip(transfer, targetSession, localMissing);

  return (
    <TransferDetailTooltip
      key={`transfer-${transfer.transferId}`}
      enabled={props.detailPreviewEnabled}
      status={transfer.status}
      title={detailTooltip}
    >
      <article className="transferListItem">
        <div className="transferListHeader">
          <div className="transferListTitle">
            <strong>{transferName(transfer)}</strong>
            <span>
              {transfer.direction === "upload" ? "上传" : "下载"} ·{" "}
              <span className={`transferInlineStatus transferInlineStatus-${transferStatusTone(transfer)}`}>
                {transferStatusText(transfer)}
              </span>
              {localMissing && (
                <>
                  {" · "}
                  <span className="transferInlineStatus transferInlineStatus-failed transferLocalMissingBadge">
                    本地文件不存在
                  </span>
                </>
              )}
            </span>
          </div>
          <Space size={4}>
            {running && (
              <Tooltip title="暂停">
                <Button
                  aria-label="暂停传输"
                  icon={<PauseOutlined />}
                  size="small"
                  onClick={() => props.onPause(transfer.transferId)}
                />
              </Tooltip>
            )}
            {paused && (
              <Tooltip title="继续">
                <Button
                  aria-label="继续传输"
                  icon={<PlayCircleOutlined />}
                  size="small"
                  onClick={() => props.onResume(transfer.transferId)}
                />
              </Tooltip>
            )}
            {retryable && (
              <Tooltip title={retryTitle}>
                <Button
                  aria-label="重试传输"
                  icon={<ReloadOutlined />}
                  size="small"
                  disabled={retryDisabled}
                  onClick={() => props.onRetry(transfer.transferId)}
                />
              </Tooltip>
            )}
            {(running || paused) && (
              <Tooltip title="停止">
                <Button
                  aria-label="停止传输"
                  icon={<StopOutlined />}
                  size="small"
                  danger
                  onClick={() => props.onCancel(transfer.transferId)}
                />
              </Tooltip>
            )}
            {transfer.direction === "download" && (
              <Tooltip title="打开文件夹">
                <Button
                  aria-label="打开文件夹"
                  icon={<FolderOpenOutlined />}
                  size="small"
                  onClick={() => props.onOpenDir(transfer.localPath)}
                />
              </Tooltip>
            )}
            {canRemoveTransfer(transfer) && (
              <Tooltip title="删除记录">
                <Button
                  aria-label="删除传输记录"
                  icon={<DeleteOutlined />}
                  size="small"
                  onClick={() => props.onRemove(transfer.transferId)}
                />
              </Tooltip>
            )}
          </Space>
        </div>
        <div className="transferListPaths">
          <span>
            {transfer.direction === "upload" ? "目标终端" : "来源终端"}：{targetSession?.name ?? "未知终端"}
            {targetSession ? ` · ${targetConnected ? "已连接" : "未连接"}` : ""}
          </span>
          <span>来源：{transferSourcePath(transfer)}</span>
          <span>{transfer.direction === "upload" ? "目标" : "保存"}：{transferTargetPath(transfer)}</span>
        </div>
        <Progress
          percent={percent}
          size="small"
          status={transferProgressStatus(transfer)}
          showInfo={false}
        />
        <div className="transferListMeta">
          <span>{formatBytes(transfer.bytesDone)} / {formatBytes(transfer.bytesTotal)}</span>
          <span>{formatTransferSpeed(transfer)}</span>
        </div>
        {transfer.error && !isTransferDone(transfer) && <div className="transferListError">{transfer.error}</div>}
      </article>
    </TransferDetailTooltip>
  );
}

interface TransferDetailTooltipProps {
  enabled: boolean;
  status: TransferInfo["status"];
  title: ReactNode;
  children: ReactElement;
}

function TransferDetailTooltip({ enabled, status, title, children }: TransferDetailTooltipProps) {
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (!enabled) setPreviewOpen(false);
  }, [enabled]);

  useEffect(() => {
    setPreviewOpen(false);
  }, [status]);

  return (
    <Tooltip
      open={enabled && previewOpen}
      onOpenChange={(nextOpen) => setPreviewOpen(enabled && nextOpen)}
      title={title}
      placement="left"
      color="#ffffff"
      mouseLeaveDelay={0}
      destroyOnHidden
      classNames={{ root: "detailHoverTooltip transferDetailHoverTooltip" }}
    >
      {children}
    </Tooltip>
  );
}

function sessionForTransfer(
  transfer: TransferInfo,
  sessionLookup: TransferSessionLookup,
) {
  return (
    sessionLookup.bySftpId.get(transfer.sftpId) ??
    sessionLookup.bySessionId.get(transfer.sessionId) ??
    null
  );
}

function shouldCheckTransferLocalPath(transfer: TransferInfo) {
  return !isActiveTransfer(transfer) && transfer.localPath.trim().length > 0;
}

function transferDetailTooltip(
  transfer: TransferInfo,
  targetSession: RemoteSession | null,
  localMissing: boolean,
) {
  return (
    <div className="detailHoverPanel transferDetailHoverPanel">
      <div className="detailHoverHeader">
        <div className="detailHoverTitle">{transferName(transfer)}</div>
        <div className={`detailHoverBadge detailHoverBadge-${transferStatusTone(transfer)}`}>
          {transfer.direction === "upload" ? "上传" : "下载"} · {transferStatusText(transfer)}
        </div>
      </div>
      <div className="detailHoverGrid">
        <span>终端</span>
        <strong>{targetSession?.name ?? "未知终端"}</strong>
        <span>来源</span>
        <strong>{transferSourcePath(transfer)}</strong>
        <span>{transfer.direction === "upload" ? "目标" : "保存"}</span>
        <strong>{transferTargetPath(transfer)}</strong>
        {localMissing && (
          <>
            <span>本地文件</span>
            <strong className="detailHoverError">不存在：{transfer.localPath}</strong>
          </>
        )}
        <span>大小</span>
        <strong>{formatBytes(transfer.bytesDone)} / {formatBytes(transfer.bytesTotal)}</strong>
        <span>创建时间</span>
        <strong>{formatBeijingDateTime(transfer.createdAt)}</strong>
        <span>更新时间</span>
        <strong>{formatBeijingDateTime(transfer.updatedAt)}</strong>
        {transfer.error && !isTransferDone(transfer) && (
          <>
            <span>错误</span>
            <strong className="detailHoverError">{transfer.error}</strong>
          </>
        )}
      </div>
    </div>
  );
}
