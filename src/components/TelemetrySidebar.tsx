import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  ClockCircleOutlined,
  FileSearchOutlined,
  MonitorOutlined,
} from "@ant-design/icons";
import { Popover } from "antd";
import { useEffect, useState, useRef } from "react";
import { writeClipboardText } from "../lib/clipboard";
import { formatElapsedSince } from "../lib/duration";
import { percent } from "../lib/format";
import { createEmptyTelemetry } from "../lib/remoteDefaults";
import { useTimeoutRegistry } from "../lib/reactLifecycle";
import type { DiskMetric, NetworkInterfaceMetric, RemoteSession } from "../types";

interface TelemetrySidebarProps {
  session: RemoteSession;
}

function formatNetworkRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 K/s";
  const units = ["K/s", "M/s", "G/s", "T/s", "P/s"];
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const digits = scaled >= 100 ? 0 : 1;
  return `${scaled.toFixed(digits)} ${units[unitIndex]}`;
}

function formatLinkSpeed(value?: number | null) {
  if (!value || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 1000) {
    const gbps = value / 1000;
    return `${Number.isInteger(gbps) ? gbps.toFixed(0) : gbps.toFixed(1)} Gbps`;
  }
  return `${value} Mbps`;
}

function formatLatency(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "- ms";
  if (value < 1) return "<1 ms";
  return `${Math.round(value)} ms`;
}

// 格式化为紧凑格式，例如 "254/962 MB" 或 "120/500 GB"
function formatCompactUsage(metric: { used: number; total: number }): string {
  const { used, total } = metric;
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(total) / Math.log(1024)), units.length - 1);
  const div = 1024 ** unitIndex;
  const usedVal = Math.round(used / div);
  const totalVal = Math.round(total / div);
  return `${usedVal}/${totalVal} ${units[unitIndex]}`;
}

export function TelemetrySidebar({ session }: TelemetrySidebarProps) {
  const [copiedKey, setCopiedKey] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const setSafeTimeout = useTimeoutRegistry();
  const isConnected = session.state === "connected";
  const telemetry = isConnected ? session.telemetry : createEmptyTelemetry(session.host);
  const networkInterfaces = isConnected
    ? normalizedNetworkInterfaces(telemetry.network.interfaces, telemetry.network)
    : [];
  const diskUsage = aggregateDiskUsage(telemetry.disks);
  const cpuText = isConnected ? `${Math.round(telemetry.cpu)}%` : "-";
  const memoryText = isConnected ? formatCompactUsage(telemetry.memory) : "-";
  const swapVisible = isConnected && telemetry.swap.total > 0;
  const swapText = swapVisible ? formatCompactUsage(telemetry.swap) : "-";
  const diskText = isConnected && diskUsage.total > 0 ? formatCompactUsage(diskUsage) : "-";
  const uploadText = formatNetworkRate(isConnected ? telemetry.network.uploadKbps : 0);
  const downloadText = formatNetworkRate(isConnected ? telemetry.network.downloadKbps : 0);
  const latencyText = formatLatency(isConnected ? telemetry.network.latencyMs : 0);
  const sshVersionText = isConnected ? session.sshVersion || "-" : "-";
  const connectedDurationText = isConnected ? formatElapsedSince(session.connectedAt, now) : "-";
  const ipv6Text = isConnected && telemetry.ipv6 && telemetry.ipv6 !== "//" ? telemetry.ipv6 : "//";

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function copyValue(key: string, value: string) {
    if (!value || value === "-" || value === "//") return;
    if (!(await writeClipboardText(value))) return;
    setCopiedKey(key);
    setSafeTimeout(() => setCopiedKey(""), 900);
  }

  return (
    <aside className="telemetrySidebar">
      <section className="resourcePanel">
        <div className="sectionTitle">
          <MonitorOutlined />
          <span>系统监控</span>
        </div>
        <div className="metric-ring-grid">
          <RingGauge label="CPU" value={cpuText} percentValue={isConnected ? telemetry.cpu : 0} tone="green" />
          <RingGauge label="内存" value={memoryText} percentValue={isConnected ? percent(telemetry.memory) : 0} tone="purple" />
          {swapVisible ? (
            <RingGauge label="Swap" value={swapText} percentValue={percent(telemetry.swap)} tone="cyan" />
          ) : null}
          <RingGauge label="磁盘" value={diskText} percentValue={isConnected ? percent(diskUsage) : 0} tone="blue" />
        </div>
          <div className="network-chart-card">
            <div className="network-chart-header">
              <div className="network-chart-header-left">
                <span>网络</span>
                <span className="networkLatencyBadge" title="本地到终端延迟">
                  {latencyText}
                </span>
              </div>
              <Popover
                trigger="click"
                placement="bottomRight"
                classNames={{ root: "networkInterfacesPopover" }}
                title={`网卡接口 · ${networkInterfaces.length} 个`}
                content={<NetworkInterfacesPanel interfaces={networkInterfaces} />}
              >
                <button
                  type="button"
                  className="metricNetworkButton"
                  disabled={!isConnected || networkInterfaces.length === 0}
                  title={telemetry.network.interfaceName || undefined}
                >
                  {telemetry.network.interfaceName || "-"}
                </button>
              </Popover>
            </div>
            <div className="networkRateList">
              <div className="rate-item rate-upload">
                <span className="rate-dot" />
                <span className="rate-label">上传</span>
                <span className="rate-value">{uploadText}</span>
              </div>
              <div className="rate-item rate-download">
                <span className="rate-dot" />
                <span className="rate-label">下载</span>
                <span className="rate-value">{downloadText}</span>
              </div>
            </div>
            <NetworkChart
              uploadKbps={isConnected ? telemetry.network.uploadKbps : 0}
              downloadKbps={isConnected ? telemetry.network.downloadKbps : 0}
            />
          </div>
      </section>

      <section className="sidebarSection connectionInfoSection">
        <div className="sectionTitle">
          <FileSearchOutlined />
          <span>连接信息</span>
        </div>
        <div className="connectionInfoList">
          <div className="connectionInfoItem">
            <span className="connection-node-dot" />
            <span className="connectionInfoLabel">主机地址</span>
            <button
              type="button"
              className="connectionInfoCopyValue"
              title={session.host}
              onClick={() => void copyValue("host", session.host)}
            >
              {copiedKey === "host" ? "已复制" : session.host}
            </button>
          </div>
          <div className="connectionInfoItem">
            <span className="connection-node-dot" />
            <span className="connectionInfoLabel">IPv6</span>
            <button
              type="button"
              className="connectionInfoCopyValue"
              title={ipv6Text}
              disabled={ipv6Text === "//"}
              onClick={() => void copyValue("ipv6", ipv6Text)}
            >
              {copiedKey === "ipv6" ? "已复制" : ipv6Text}
            </button>
          </div>
          <div className="connectionInfoItem">
            <span className="connection-node-dot" />
            <span className="connectionInfoLabel">用户名</span>
            <span className="connectionInfoValue" title={session.username}>{session.username}</span>
          </div>
          <div className="connectionInfoItem">
            <span className="connection-node-dot" />
            <span className="connectionInfoLabel">SSH版本</span>
            <span className="connectionInfoValue" title={sshVersionText}>{sshVersionText}</span>
          </div>
          <div className="connectionInfoItem">
            <span className="connection-node-dot" />
            <span className="connectionInfoLabel">运行时间</span>
            <span className="connectionInfoValue" title={telemetry.uptime || undefined}>
              <ClockCircleOutlined />
              <span>{telemetry.uptime || "-"}</span>
            </span>
          </div>
          <div className="connectionInfoItem">
            <span className="connection-node-dot" />
            <span className="connectionInfoLabel">连接时长</span>
            <span className="connectionInfoValue" title={connectedDurationText}>
              <ClockCircleOutlined />
              {connectedDurationText}
            </span>
          </div>
        </div>
      </section>
    </aside>
  );
}

function normalizedNetworkInterfaces(
  interfaces: NetworkInterfaceMetric[] | undefined,
  primary: {
    interfaceName: string;
    uploadKbps: number;
    downloadKbps: number;
  },
) {
  if (interfaces && interfaces.length > 0) return interfaces;
  if (!primary.interfaceName || primary.interfaceName === "-") return [];
  return [
    {
      interfaceName: primary.interfaceName,
      uploadKbps: primary.uploadKbps,
      downloadKbps: primary.downloadKbps,
      linkSpeedMbps: null,
    },
  ];
}

function NetworkInterfacesPanel({ interfaces }: { interfaces: NetworkInterfaceMetric[] }) {
  if (interfaces.length === 0) {
    return <div className="networkInterfacesEmpty">暂无网卡数据</div>;
  }
  return (
    <div className="networkInterfacesPanel">
      {interfaces.map((item) => {
        const linkSpeed = formatLinkSpeed(item.linkSpeedMbps);
        return (
          <div className="networkInterfaceRow" key={item.interfaceName}>
            <span className="networkInterfaceName" title={item.interfaceName}>{item.interfaceName}</span>
            {linkSpeed ? (
              <span className="networkInterfaceSpeed" title="接口链路速率">
                {linkSpeed}
              </span>
            ) : null}
            <span className="networkInterfaceRate">
              <ArrowUpOutlined /> {formatNetworkRate(item.uploadKbps)}
            </span>
            <span className="networkInterfaceRate">
              <ArrowDownOutlined /> {formatNetworkRate(item.downloadKbps)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function aggregateDiskUsage(disks: DiskMetric[]) {
  return disks.reduce(
    (total, disk) => ({
      used: total.used + disk.used,
      total: total.total + disk.total,
    }),
    { used: 0, total: 0 },
  );
}

// 环形进度条组件，用于替代旧的条形进度条以展示系统指标（CPU、内存等）
function RingGauge({ percentValue, label, value, tone }: { percentValue: number; label: string; value: string; tone: string }) {
  const radius = 22;
  const strokeWidth = 3.5;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (Math.min(100, Math.max(0, percentValue)) / 100) * circumference;

  return (
    <div className={`metric-ring-card metric-ring-${tone}`}>
      <div className="metric-ring-chart">
        <svg height={radius * 2 + strokeWidth * 2} width={radius * 2 + strokeWidth * 2} className="ring-svg-canvas">
          {/* 背景圆槽，赋予稍微粗一点的凹陷立体效果 */}
          <circle
            stroke="var(--ring-track-color, rgba(226, 232, 240, 0.6))"
            fill="transparent"
            strokeWidth={strokeWidth + 0.5}
            r={radius}
            cx={radius + strokeWidth}
            cy={radius + strokeWidth}
          />
          {/* 前景进度圆环，带高端的发光滤镜与圆角 */}
          <circle
            className="metric-ring-progress"
            fill="transparent"
            strokeWidth={strokeWidth}
            strokeDasharray={`${circumference} ${circumference}`}
            style={{ 
              strokeDashoffset, 
              strokeLinecap: "round",
              filter: `drop-shadow(0 0 3px var(--ring-glow-${tone}, rgba(99, 102, 241, 0.4)))`
            }}
            r={radius}
            cx={radius + strokeWidth}
            cy={radius + strokeWidth}
          />
        </svg>
        <span className="metric-ring-percent">{Math.round(percentValue)}%</span>
      </div>
      <div className="metric-ring-info">
        <span className="metric-ring-label">{label}</span>
        <strong className="metric-ring-value">{value}</strong>
      </div>
    </div>
  );
}

// 实时网络曲线图组件，用于缓存并绘制最近 60 次采样点的上传与下载速率
function NetworkChart({
  uploadKbps,
  downloadKbps,
}: {
  uploadKbps: number;
  downloadKbps: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const uploadHistory = useRef<number[]>(Array(60).fill(0));
  const downloadHistory = useRef<number[]>(Array(60).fill(0));

  useEffect(() => {
    uploadHistory.current.push(uploadKbps);
    uploadHistory.current.shift();
    downloadHistory.current.push(downloadKbps);
    downloadHistory.current.shift();

    const canvas = canvasRef.current;
    if (canvas) {
      const ups = uploadHistory.current;
      const dws = downloadHistory.current;
      const max = Math.max(...ups, ...dws, 10);
      drawNetworkCanvas(canvas, ups, dws, max);
    }
  }, [uploadKbps, downloadKbps]);

  return (
    <div className="network-chart-container">
      <canvas ref={canvasRef} className="network-chart-canvas" width={240} height={80} />
    </div>
  );
}

// 高清晰度贝塞尔曲线网络 Canvas 渲染器
function drawNetworkCanvas(canvas: HTMLCanvasElement, ups: number[], dws: number[], max: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement?.clientWidth || 248;
  const h = 90;

  // Retina 屏幕高倍率清晰度处理
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // 绘制横向网格参考线
  ctx.strokeStyle = "rgba(203, 213, 225, 0.2)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let i = 1; i <= 3; i++) {
    const y = (h / 4) * i;
    ctx.moveTo(4, y);
    ctx.lineTo(w - 4, y);
  }
  ctx.stroke();

  // 绘制贝塞尔三次曲线子过程
  const drawBezier = (data: number[], strokeColor: string, fillGrad: CanvasGradient, shadowColor: string) => {
    const len = data.length;
    if (len < 2) return;
    const pts = data.map((val, i) => ({
      x: (w / (len - 1)) * i,
      y: h - (val / max) * (h - 18) - 9
    }));

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < len - 1; i++) {
      const cpX = pts[i].x + (pts[i + 1].x - pts[i].x) / 2;
      ctx.bezierCurveTo(cpX, pts[i].y, cpX, pts[i + 1].y, pts[i + 1].x, pts[i + 1].y);
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.8;
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = 3;
    ctx.stroke();
    ctx.restore();

    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();
  };

  const upGrad = ctx.createLinearGradient(0, 8, 0, h);
  upGrad.addColorStop(0, "rgba(16, 185, 129, 0.14)");
  upGrad.addColorStop(1, "rgba(16, 185, 129, 0)");
  drawBezier(ups, "#10b981", upGrad, "rgba(16, 185, 129, 0.3)");

  const dwGrad = ctx.createLinearGradient(0, 8, 0, h);
  dwGrad.addColorStop(0, "rgba(59, 130, 246, 0.14)");
  dwGrad.addColorStop(1, "rgba(59, 130, 246, 0)");
  drawBezier(dws, "#3b82f6", dwGrad, "rgba(59, 130, 246, 0.3)");
}
