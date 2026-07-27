import {
  AppleOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  ExclamationCircleOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  RightOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
  WindowsOutlined,
} from "@ant-design/icons";
import { Button, Modal, Tooltip, Typography } from "antd";
import { formatBytes } from "../../lib/format";
import type { AppInfo, UpdateInfo } from "../../types";

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
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
  onOpenDatabaseDir: () => Promise<void>;
  onOpenPathDir: (path: string) => Promise<void>;
  onOpenExternalUrl: (url: string) => Promise<void>;
  onShowReleaseNotes: () => void;
}

export function AboutModal({
  open, onClose, appInfo, updateInfo, updateError, updateChecking, updateDownloading,
  downloadedUpdatePath, updateRepo, onCheckUpdate, onDownloadUpdate, onInstallUpdate,
  onOpenDatabaseDir, onOpenPathDir, onOpenExternalUrl, onShowReleaseNotes,
}: AboutModalProps) {
  const canDownloadUpdate = Boolean(updateInfo?.hasUpdate && updateInfo.asset);
  const canInstallUpdate = Boolean(downloadedUpdatePath);
  const updateActionLoading = canInstallUpdate ? false : canDownloadUpdate ? updateDownloading : updateChecking;
  const updateActionLabel = canInstallUpdate ? "立即安装" : canDownloadUpdate ? "下载更新" : "检查更新";
  const updateActionIcon = canInstallUpdate ? <RocketOutlined /> : canDownloadUpdate ? <CloudDownloadOutlined /> : <SyncOutlined spin={updateChecking} />;
  const currentVersion = appInfo?.version ?? "0.0.0";
  const handleUpdateAction = () => {
    if (canInstallUpdate) { void onInstallUpdate(); return; }
    if (canDownloadUpdate) { void onDownloadUpdate(); return; }
    void onCheckUpdate(true);
  };

  return (
    <Modal open={open} title={null} className="aboutVersionModal" footer={null} closable onCancel={onClose} width={640} centered>
      <div className="aboutModalShell">
        <header className="aboutModalHeader">
          <span className="aboutModalHeaderIcon" aria-hidden="true"><InfoCircleOutlined /></span>
          <div className="aboutModalHeaderCopy">
            <strong>关于 HelM</strong>
            <span>版本信息、运行环境与软件更新</span>
          </div>
          <span className="aboutModalEdition">桌面客户端</span>
        </header>

        <div className="aboutModalBody">
          <section className="aboutProductCard">
            <div className="aboutProductMark"><img src="./Helm_icon.svg" alt="" aria-hidden="true" /></div>
            <div className="aboutProductCopy">
              <span className="aboutProductEyebrow">HELM DESKTOP</span>
              <div className="aboutProductTitleLine">
                <h2>HelM</h2>
                <span className="aboutProductVersion">
                  {updateRepo ? (
                    <Tooltip title={`点击查看 v${currentVersion} 的 Release 页面`}>
                      <Typography.Link className="aboutVersionLink" href={`https://github.com/${updateRepo}/releases/tag/v${currentVersion}`} onClick={(e) => { e.preventDefault(); void onOpenExternalUrl(`https://github.com/${updateRepo}/releases/tag/v${currentVersion}`); }}>
                        v{currentVersion}
                      </Typography.Link>
                    </Tooltip>
                  ) : <span>v{currentVersion}</span>}
                </span>
              </div>
              <p>安全、高效的 SSH 连接管理工具</p>
            </div>
            <div className="aboutProductTrust"><SafetyCertificateOutlined /><span>本地安全存储</span></div>
          </section>

          {updateInfo?.hasUpdate ? (
            <button type="button" className="aboutStatusBanner aboutStatusBanner--success aboutStatusBanner--action" onClick={onShowReleaseNotes} aria-label="查看更新日志">
              <span className="aboutStatusIcon"><RocketOutlined /></span>
              <div className="aboutStatusText">
                <strong>发现新版本 {updateInfo.tagName || `v${updateInfo.latestVersion}`}</strong>
                <span>{updateInfo.asset ? `${updateInfo.asset.name} · ${formatBytes(updateInfo.asset.size, { invalidText: "未知大小", zeroText: "未知大小" })}` : "当前 Release 没有找到 Windows 安装包"}</span>
              </div>
              <RightOutlined className="aboutStatusArrow" />
            </button>
          ) : updateInfo ? (
            <button type="button" className="aboutStatusBanner aboutStatusBanner--info aboutStatusBanner--action" onClick={onShowReleaseNotes} aria-label="查看更新日志">
              <span className="aboutStatusIcon"><CheckCircleOutlined /></span>
              <div className="aboutStatusText">
                <strong>当前已是最新版本 {updateInfo.tagName || `v${updateInfo.latestVersion}`}</strong>
                <span>查看当前版本的更新记录</span>
              </div>
              <RightOutlined className="aboutStatusArrow" />
            </button>
          ) : updateError ? (
            <div className="aboutStatusBanner aboutStatusBanner--warning">
              <span className="aboutStatusIcon"><ExclamationCircleOutlined /></span>
              <div className="aboutStatusText"><strong>检查更新失败</strong><span>{updateError}</span></div>
            </div>
          ) : !updateRepo ? (
            <div className="aboutStatusBanner aboutStatusBanner--warning">
              <span className="aboutStatusIcon"><ExclamationCircleOutlined /></span>
              <div className="aboutStatusText"><strong>当前构建未配置更新仓库</strong><span>GitHub Actions 发布版会自动写入仓库地址</span></div>
            </div>
          ) : null}

          <section className="aboutDetailsSection">
            <div className="aboutDetailsHeading">
              <div><strong>运行信息</strong><span>当前安装与数据存储环境</span></div>
              <span>{appInfo ? "信息已读取" : "正在读取"}</span>
            </div>
            <div className="aboutInfoCards">
              <div className="aboutInfoCard">
                <span className="aboutInfoCardIcon">{systemIcon(appInfo?.os)}</span>
                <div className="aboutInfoCardContent"><span className="aboutInfoCardLabel">系统架构</span><span className="aboutInfoCardValue">{(appInfo?.os ?? "--") + " / " + (appInfo?.arch ?? "--")}</span></div>
              </div>
              <div className="aboutInfoCard">
                <span className="aboutInfoCardIcon"><LinkOutlined /></span>
                <div className="aboutInfoCardContent">
                  <span className="aboutInfoCardLabel">更新源</span>
                  <span className="aboutInfoCardValue">
                    {updateRepo ? (
                      <Tooltip title="点击在浏览器打开 GitHub 仓库"><Typography.Link href={`https://github.com/${updateRepo}`} onClick={(e) => { e.preventDefault(); void onOpenExternalUrl(`https://github.com/${updateRepo}`); }}>{updateRepo}</Typography.Link></Tooltip>
                    ) : <Typography.Text type="secondary">未配置</Typography.Text>}
                  </span>
                </div>
              </div>
              <div className="aboutInfoCard is-wide">
                <span className="aboutInfoCardIcon"><DatabaseOutlined /></span>
                <div className="aboutInfoCardContent">
                  <span className="aboutInfoCardLabel">数据库</span>
                  <span className="aboutInfoCardValue aboutInfoCardValue--path">
                    <Typography.Text ellipsis={{ tooltip: appInfo?.databasePath }}>{appInfo?.databasePath ?? "--"}</Typography.Text>
                    <Tooltip title="打开数据库目录"><Button type="text" size="small" icon={<FolderOpenOutlined />} aria-label="打开数据库目录" className="aboutPathBtn" onClick={() => void onOpenDatabaseDir()} /></Tooltip>
                  </span>
                </div>
              </div>
              {downloadedUpdatePath ? (
                <div className="aboutInfoCard is-wide">
                  <span className="aboutInfoCardIcon"><FolderOpenOutlined /></span>
                  <div className="aboutInfoCardContent">
                    <span className="aboutInfoCardLabel">下载位置</span>
                    <span className="aboutInfoCardValue aboutInfoCardValue--path">
                      <Typography.Text ellipsis={{ tooltip: downloadedUpdatePath }}>{downloadedUpdatePath}</Typography.Text>
                      <Tooltip title="打开下载目录"><Button type="text" size="small" icon={<FolderOpenOutlined />} aria-label="打开下载目录" className="aboutPathBtn" onClick={() => void onOpenPathDir(downloadedUpdatePath)} /></Tooltip>
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <footer className="aboutModalFooter">
          <Button className="aboutCloseBtn" onClick={onClose}>关闭</Button>
          <Button className="aboutUpdateBtn" type={canInstallUpdate || canDownloadUpdate ? "primary" : "default"} icon={updateActionIcon} loading={updateActionLoading} disabled={!canInstallUpdate && (!updateRepo || (Boolean(updateInfo?.hasUpdate) && !updateInfo?.asset))} onClick={handleUpdateAction}>
            {updateActionLabel}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

function systemIcon(os?: string | null) {
  const value = os?.toLowerCase() ?? "";
  if (value.includes("windows")) return <WindowsOutlined />;
  if (value.includes("mac")) return <AppleOutlined />;
  return <DesktopOutlined />;
}
