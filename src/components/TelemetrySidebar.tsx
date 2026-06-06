import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  ClockCircleOutlined,
  DesktopOutlined,
  HddOutlined,
  WifiOutlined,
} from "@ant-design/icons";
import { Popover, Progress, Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import { formatBytes, formatUsage, percent } from "../lib/format";
import { createEmptyTelemetry } from "../lib/remoteDefaults";
import type { DiskMetric, NetworkInterfaceMetric, ProcessInfo, RemoteSession } from "../types";
import { useState } from "react";
import { useTimeoutRegistry } from "../lib/reactLifecycle";

interface TelemetrySidebarProps {
  session: RemoteSession;
}

const processColumns: ColumnsType<ProcessInfo> = [
  { title: "进程", dataIndex: "name", ellipsis: true, width: 82 },
  {
    title: "CPU",
    dataIndex: "cpu",
    width: 66,
    render: (value: number) => `${value.toFixed(1)}%`,
    sorter: (a, b) => a.cpu - b.cpu,
    defaultSortOrder: "descend",
  },
  {
    title: "内存",
    dataIndex: "memory",
    width: 52,
    render: (value: number) => `${value.toFixed(0)}M`,
  },
];

const diskColumns: ColumnsType<DiskMetric> = [
  { title: "挂载点", dataIndex: "mount", ellipsis: true, width: 74 },
  {
    title: "可用 / 总计",
    width: 116,
    render: (_, item) => `${formatBytes(item.total - item.used)} / ${formatBytes(item.total)}`,
  },
];

function formatNetworkRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 K/s";
  const units = ["K/s", "M/s", "G/s", "T/s", "P/s"];
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 1;
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

export function TelemetrySidebar({
  session,
}: TelemetrySidebarProps) {
  const [copied, setCopied] = useState(false);
  const setSafeTimeout = useTimeoutRegistry();
  const isConnected = session.state === "connected";
  const state = session.state;
  const telemetry = isConnected ? session.telemetry : createEmptyTelemetry(session.host);
  const uptimeText = isConnected ? telemetry.uptime : "";
  const interfaceText = isConnected ? telemetry.network.interfaceName : "网络";
  const latencyText = isConnected ? `${telemetry.network.latencyMs} ms` : "";
  const networkInterfaces = isConnected
    ? normalizedNetworkInterfaces(telemetry.network.interfaces, telemetry.network)
    : [];

  return (
    <aside className="telemetrySidebar">
      <section className="statusSummaryPanel">
        <div className="statusSummaryHeader">
          <span className="statusSummaryState">
            <span className={`stateDot stateDot-${state}`} />
            <strong>{isConnected ? "已连接" : "未连接"}</strong>
          </span>
          {isConnected && telemetry.ip && (
            <button
              type="button"
              className="statusSummaryIp"
              title={telemetry.ip}
              onClick={() => {
                void navigator.clipboard.writeText(telemetry.ip);
                setCopied(true);
                setSafeTimeout(() => setCopied(false), 900);
              }}
            >
              {copied ? "已复制" : telemetry.ip}
            </button>
          )}
        </div>
        <div className="statusSummaryGrid">
          <span className="statusSummaryTile">
            <span className="statusSummaryTileLabel" title="运行时间">
              <ClockCircleOutlined />
              <span>运行时间</span>
            </span>
            <strong title={uptimeText || undefined}>{uptimeText}</strong>
          </span>
          <Popover
            trigger="click"
            placement="bottomRight"
            classNames={{ root: "networkInterfacesPopover" }}
            title={`网卡接口 · ${networkInterfaces.length} 个`}
            content={<NetworkInterfacesPanel interfaces={networkInterfaces} />}
          >
            <button type="button" className="statusSummaryTile statusSummaryTileButton" disabled={!isConnected}>
              <span className="statusSummaryTileLabel" title={interfaceText}>
                <WifiOutlined />
                <span>{interfaceText}</span>
              </span>
              <strong title={latencyText || undefined}>{latencyText}</strong>
            </button>
          </Popover>
        </div>
        <div className="networkStats">
          <span>
            <ArrowUpOutlined /> {formatNetworkRate(isConnected ? telemetry.network.uploadKbps : 0)}
          </span>
          <span>
            <ArrowDownOutlined /> {formatNetworkRate(isConnected ? telemetry.network.downloadKbps : 0)}
          </span>
        </div>
      </section>

      {isConnected && (
        <section className="resourcePanel">
          <div className="sectionTitle">
            <DesktopOutlined />
            <span>资源</span>
          </div>
          <MetricBar label="CPU" value={telemetry.cpu} statusColor="var(--accent)" />
          <MetricBar
            label="内存"
            value={percent(telemetry.memory)}
            text={formatUsage(telemetry.memory)}
            statusColor="var(--orange)"
          />
          <MetricBar
            label="交换"
            value={percent(telemetry.swap)}
            text={formatUsage(telemetry.swap)}
            statusColor="var(--success)"
          />
        </section>
      )}

      {isConnected && (
        <section className="sidebarSection">
          <div className="sectionTitle">
            <DesktopOutlined />
            <span>进程</span>
          </div>
          <Table
            rowKey="pid"
            size="small"
            pagination={false}
            columns={processColumns}
            dataSource={telemetry.processes}
            scroll={{ y: 130 }}
            locale={{ emptyText: "暂无进程数据" }}
          />
        </section>
      )}

      {isConnected && (
        <section className="sidebarSection">
          <div className="sectionTitle">
            <HddOutlined />
            <span>磁盘</span>
          </div>
          <Table
            rowKey="mount"
            size="small"
            pagination={false}
            columns={diskColumns}
            dataSource={telemetry.disks}
            locale={{ emptyText: "暂无磁盘数据" }}
          />
        </section>
      )}
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

function MetricBar({
  label,
  value,
  text,
  statusColor,
}: {
  label: string;
  value: number;
  text?: string;
  statusColor: string;
}) {
  return (
    <div className="metricBar">
      <div className="metricBarLabel">
        <span>{label}</span>
        <span>{text ?? `${value}%`}</span>
      </div>
      <Progress percent={value} showInfo={false} strokeColor={statusColor} railColor="#e4e9ef" size="small" />
    </div>
  );
}
