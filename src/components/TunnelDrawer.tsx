import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  GlobalOutlined,
  LinkOutlined,
  NodeIndexOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  ShareAltOutlined,
  StopOutlined,
  SwapOutlined,
  TagOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { App as AntdApp, Button, Form, Input, InputNumber, Modal, Segmented, Select, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { writeClipboardText } from "../lib/clipboard";
import { getErrorMessage } from "../lib/configMapping";
import { formatElapsedSince } from "../lib/duration";
import { useMountedRef } from "../lib/reactLifecycle";
import type { ForwardInfo, RemoteSession, TunnelConfig, TunnelInput } from "../types";

interface TunnelDrawerProps {
  open: boolean;
  sessions: RemoteSession[];
  tunnels: TunnelConfig[];
  forwards: ForwardInfo[];
  onClose: () => void;
  onCreate: (input: TunnelInput) => Promise<void>;
  onUpdate: (id: string, input: TunnelInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onStart: (tunnel: TunnelConfig) => Promise<void>;
  onStop: (forwardId: string) => Promise<void>;
}

type TunnelModalState =
  | { requestId: string; mode: "create"; initialType?: TunnelInput["forwardType"] }
  | { requestId: string; mode: "edit"; value: TunnelConfig };
type TunnelView = "templates" | "running";
type TunnelTypeFilter = "all" | TunnelInput["forwardType"];

export function TunnelDrawer({
  open,
  sessions,
  tunnels,
  forwards,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onStart,
  onStop,
}: TunnelDrawerProps) {
  const { message, modal } = AntdApp.useApp();
  const [editing, setEditing] = useState<TunnelModalState | null>(null);
  const [activeView, setActiveView] = useState<TunnelView>("templates");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TunnelTypeFilter>("all");
  const [operationKey, setOperationKey] = useState<string | null>(null);
  const operationKeyRef = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mountedRef = useMountedRef();
  const editingRef = useRef<TunnelModalState | null>(null);
  const openCycleRef = useRef(0);
  const openRef = useRef(open);
  if (openRef.current !== open) {
    openRef.current = open;
    openCycleRef.current += 1;
  }
  editingRef.current = editing;
  const sessionNameById = useMemo(() => new Map(sessions.map((session) => [session.id, session.name])), [sessions]);
  const activeForwards = useMemo(
    () => forwards.filter((forward) => isForwardActive(forward)),
    [forwards],
  );
  const failedForwards = useMemo(
    () => forwards.filter((forward) => forward.status === "failed"),
    [forwards],
  );
  const forwardByTunnelId = useMemo(() => {
    const byTunnelId = new Map<string, ForwardInfo>();
    const exactForwards = new Map<string, ForwardInfo>();
    const autoPortForwards = new Map<string, ForwardInfo>();
    const prioritizedForwards = [...forwards].sort(
      (left, right) => forwardStatusRank(left.status) - forwardStatusRank(right.status),
    );
    for (const forward of prioritizedForwards) {
      if (forward.tunnelId && !byTunnelId.has(forward.tunnelId)) {
        byTunnelId.set(forward.tunnelId, forward);
      }
      const exactKey = forwardExactKey(forward);
      const autoPortKey = forwardAutoPortKey(forward);
      if (!exactForwards.has(exactKey)) exactForwards.set(exactKey, forward);
      if (!autoPortForwards.has(autoPortKey)) autoPortForwards.set(autoPortKey, forward);
    }
    const map = new Map<string, ForwardInfo>();
    for (const tunnel of tunnels) {
      const running = byTunnelId.get(tunnel.id) ?? (tunnel.bindPort === 0
        ? autoPortForwards.get(tunnelAutoPortKey(tunnel))
        : exactForwards.get(tunnelExactKey(tunnel)));
      if (running) map.set(tunnel.id, running);
    }
    return map;
  }, [forwards, tunnels]);

  useEffect(() => {
    if (!open) {
      setEditing(null);
      return;
    }
    setActiveView("templates");
    setQuery("");
    setTypeFilter("all");
    setOperationKey(operationKeyRef.current);
    setNow(Date.now());
  }, [open]);

  useEffect(() => {
    if (!open || activeForwards.length === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeForwards.length, open]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredTunnels = useMemo(
    () => tunnels.filter((tunnel) => {
      if (typeFilter !== "all" && tunnel.forwardType !== typeFilter) return false;
      if (!normalizedQuery) return true;
      const searchable = [
        tunnel.name,
        sessionNameById.get(tunnel.sessionId) ?? "",
        forwardTypeLabel(tunnel.forwardType),
        tunnel.bindHost,
        String(tunnel.bindPort),
        tunnel.targetHost,
        String(tunnel.targetPort),
      ].join(" ").toLocaleLowerCase();
      return searchable.includes(normalizedQuery);
    }),
    [normalizedQuery, sessionNameById, tunnels, typeFilter],
  );
  const filteredForwards = useMemo(
    () => forwards.filter((forward) => {
      if (typeFilter !== "all" && forward.forwardType !== typeFilter) return false;
      if (!normalizedQuery) return true;
      const searchable = [
        sessionNameById.get(forward.sessionId) ?? "",
        forwardTypeLabel(forward.forwardType),
        forwardStatusLabel(forward.status),
        forward.bindHost,
        String(forward.bindPort),
        forward.targetHost,
        String(forward.targetPort),
        forward.error ?? "",
      ].join(" ").toLocaleLowerCase();
      return searchable.includes(normalizedQuery);
    }),
    [forwards, normalizedQuery, sessionNameById, typeFilter],
  );

  const primaryForward = activeForwards[0];
  const healthMode = activeForwards.length > 0 ? "active" : failedForwards.length > 0 ? "warning" : "idle";
  const healthTitle = healthMode === "active"
    ? "转发服务运行中"
    : healthMode === "warning"
      ? "存在异常隧道"
      : "隧道服务待命";
  const healthDetail = healthMode === "active"
    ? "监听正常，当前路由可用"
    : healthMode === "warning"
      ? "请检查失败信息或重新启动"
      : "从模板启动或快速创建隧道";
  const healthSession = primaryForward
    ? sessionNameById.get(primaryForward.sessionId) ?? "未知会话"
    : "暂无";
  const headerStatusText = activeForwards.length > 0
    ? `${activeForwards.length} 个隧道运行中`
    : failedForwards.length > 0
      ? `${failedForwards.length} 个隧道异常`
      : "隧道服务待命";

  async function startTunnel(tunnel: TunnelConfig) {
    const key = `start:${tunnel.id}`;
    if (operationKeyRef.current) return;
    const openCycle = openCycleRef.current;
    operationKeyRef.current = key;
    setOperationKey(key);
    try {
      await onStart(tunnel);
      if (mountedRef.current && openRef.current && openCycleRef.current === openCycle) {
        message.success("隧道已启动");
      }
    } catch (error) {
      if (mountedRef.current && openRef.current && openCycleRef.current === openCycle) {
        message.error(getErrorMessage(error));
      }
    } finally {
      if (operationKeyRef.current === key) {
        operationKeyRef.current = null;
        if (mountedRef.current) setOperationKey(null);
      }
    }
  }

  async function stopForward(forward: ForwardInfo) {
    const key = `stop:${forward.forwardId}`;
    if (operationKeyRef.current) return;
    const openCycle = openCycleRef.current;
    operationKeyRef.current = key;
    setOperationKey(key);
    try {
      await onStop(forward.forwardId);
      if (mountedRef.current && openRef.current && openCycleRef.current === openCycle) {
        message.success("隧道已停止");
      }
    } catch (error) {
      if (mountedRef.current && openRef.current && openCycleRef.current === openCycle) {
        message.error(getErrorMessage(error));
      }
    } finally {
      if (operationKeyRef.current === key) {
        operationKeyRef.current = null;
        if (mountedRef.current) setOperationKey(null);
      }
    }
  }

  function confirmDelete(tunnel: TunnelConfig) {
    const forward = forwardByTunnelId.get(tunnel.id);
    const openCycle = openCycleRef.current;
    modal.confirm({
      title: "删除隧道模板",
      content: forward
        ? `${tunnel.name} 当前存在运行实例，删除模板会同时停止该实例。`
        : `确定删除“${tunnel.name}”吗？`,
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!openRef.current || openCycleRef.current !== openCycle) return;
        await onDelete(tunnel.id);
        if (mountedRef.current && openRef.current && openCycleRef.current === openCycle) {
          message.success("隧道模板已删除");
        }
      },
    });
  }

  async function copyBindAddress(forward: ForwardInfo) {
    const value = `${forward.bindHost}:${forward.bindPort}`;
    const copied = await writeClipboardText(value);
    if (!mountedRef.current) return;
    if (copied) message.success("监听地址已复制");
    else message.error("复制监听地址失败");
  }

  function openCreate(initialType?: TunnelInput["forwardType"]) {
    setEditing({ requestId: crypto.randomUUID(), mode: "create", initialType });
  }

  function renderTemplateRows() {
    if (filteredTunnels.length === 0) {
      const isFiltered = query.trim().length > 0 || typeFilter !== "all";
      return (
        <div className="tunnelEmptyState">
          <span className="tunnelEmptyIcon"><NodeIndexOutlined /></span>
          <strong>{isFiltered ? "没有符合条件的隧道模板" : "还没有隧道模板"}</strong>
          <p>{isFiltered ? "调整关键词或类型筛选后重试。" : "创建模板后，可随时启动本地、远程或动态转发。"}</p>
          {!isFiltered && (
            <Button className="tunnelEmptyAction" type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
              新建第一个隧道
            </Button>
          )}
        </div>
      );
    }

    return (
      <div className="tunnelTableScroll">
        <div className="tunnelTemplateTable">
          <div className="tunnelTableHead">
            <span>名称</span><span>类型</span><span>会话</span><span>监听与目标</span><span>状态</span><span>操作</span>
          </div>
          <div className="tunnelTableBody">
            {filteredTunnels.map((tunnel) => {
              const forward = forwardByTunnelId.get(tunnel.id);
              const canQuickStart = !forward && operationKey === null;
              const bindHost = forward?.bindHost ?? tunnel.bindHost;
              const bindPort = forward?.bindPort ?? tunnel.bindPort;
              return (
                <div
                  className="tunnelTableRow"
                  key={tunnel.id}
                  onDoubleClick={() => {
                    if (canQuickStart) void startTunnel(tunnel);
                  }}
                >
                  <div className="tunnelNameCell">
                    <strong title={tunnel.name}>{tunnel.name}</strong>
                    <span>{forwardTypeDescription(tunnel.forwardType)}</span>
                  </div>
                  <span className={`tunnelTypeBadge is-${tunnel.forwardType}`}>{forwardTypeLabel(tunnel.forwardType)}</span>
                  <div className="tunnelSessionCell">
                    <span className="tunnelSessionIcon" aria-hidden="true"><ApartmentOutlined /></span>
                    <span title={sessionNameById.get(tunnel.sessionId) ?? "未知会话"}>
                      {sessionNameById.get(tunnel.sessionId) ?? "未知会话"}
                    </span>
                  </div>
                  <div className="tunnelRouteCell">
                    <div className="tunnelRouteLine">
                      <button
                        type="button"
                        className="tunnelRouteAddress"
                        disabled={!forward || bindPort === 0}
                        title={forward ? "复制监听地址" : undefined}
                        onClick={() => {
                          if (forward) void copyBindAddress(forward);
                        }}
                      >
                        {formatEndpoint(bindHost, bindPort)}
                      </button>
                      <span className="tunnelRouteArrow">{tunnel.forwardType === "remote" ? "←" : "→"}</span>
                      <code>{formatTunnelTarget(tunnel)}</code>
                    </div>
                    <span>{routeDescription(tunnel.forwardType)}</span>
                  </div>
                  <Tooltip title={forward?.status === "failed" ? forward.error || "隧道启动失败" : undefined}>
                    <span className={`tunnelStatePill is-${templateState(forward)}`}>
                      {forward ? forwardStatusLabel(forward.status) : "已停止"}
                    </span>
                  </Tooltip>
                  <div className="tunnelRowActions" onDoubleClick={(event) => event.stopPropagation()}>
                    {forward ? (
                      <Tooltip title={forward.status === "failed" ? "重试停止异常实例" : "停止隧道"}>
                        <Button
                          aria-label={forward.status === "failed" ? "重试停止异常实例" : "停止隧道"}
                          size="small"
                          className="tunnelRowActionButton is-primary"
                          icon={<StopOutlined />}
                          loading={operationKey === `stop:${forward.forwardId}`}
                          disabled={operationKey !== null && operationKey !== `stop:${forward.forwardId}`}
                          onClick={() => void stopForward(forward)}
                        />
                      </Tooltip>
                    ) : (
                      <Tooltip title="启动隧道">
                        <Button
                          aria-label="启动隧道"
                          size="small"
                          className="tunnelRowActionButton is-primary"
                          icon={<PlayCircleOutlined />}
                          loading={operationKey === `start:${tunnel.id}`}
                          disabled={operationKey !== null && operationKey !== `start:${tunnel.id}`}
                          onClick={() => void startTunnel(tunnel)}
                        />
                      </Tooltip>
                    )}
                    <Tooltip title="编辑模板">
                      <Button
                        aria-label="编辑模板"
                        size="small"
                        className="tunnelRowActionButton"
                        icon={<EditOutlined />}
                        disabled={operationKey !== null}
                        onClick={() => setEditing({ requestId: crypto.randomUUID(), mode: "edit", value: tunnel })}
                      />
                    </Tooltip>
                    <Tooltip title="删除模板">
                      <Button
                        aria-label="删除模板"
                        size="small"
                        danger
                        className="tunnelRowActionButton is-danger"
                        icon={<DeleteOutlined />}
                        disabled={operationKey !== null}
                        onClick={() => confirmDelete(tunnel)}
                      />
                    </Tooltip>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  function renderRunningRows() {
    if (filteredForwards.length === 0) {
      const isFiltered = query.trim().length > 0 || typeFilter !== "all";
      return (
        <div className="tunnelEmptyState">
          <span className="tunnelEmptyIcon is-running"><SwapOutlined /></span>
          <strong>{isFiltered ? "没有符合条件的运行实例" : "暂无运行中的隧道"}</strong>
          <p>{isFiltered ? "调整关键词或类型筛选后重试。" : "从隧道模板启动后，监听地址与运行时长会显示在这里。"}</p>
          {!isFiltered && tunnels.length > 0 && (
            <Button className="tunnelEmptyAction" onClick={() => setActiveView("templates")}>前往隧道模板</Button>
          )}
        </div>
      );
    }

    return (
      <div className="tunnelTableScroll">
        <div className="tunnelRunningTable">
          <div className="tunnelTableHead">
            <span>类型</span><span>会话</span><span>监听与目标</span><span>运行时长</span><span>状态</span><span>操作</span>
          </div>
          <div className="tunnelTableBody">
            {filteredForwards.map((forward) => (
              <div className="tunnelTableRow" key={forward.forwardId}>
                <span className={`tunnelTypeBadge is-${forward.forwardType}`}>{forwardTypeLabel(forward.forwardType)}</span>
                <div className="tunnelSessionCell">
                  <span className="tunnelSessionIcon" aria-hidden="true"><ApartmentOutlined /></span>
                  <span title={sessionNameById.get(forward.sessionId) ?? "未知会话"}>
                    {sessionNameById.get(forward.sessionId) ?? "未知会话"}
                  </span>
                </div>
                <div className="tunnelRouteCell">
                  <div className="tunnelRouteLine">
                    <button type="button" className="tunnelRouteAddress" title="复制监听地址" onClick={() => void copyBindAddress(forward)}>
                      {formatEndpoint(forward.bindHost, forward.bindPort)}
                    </button>
                    <span className="tunnelRouteArrow">{forward.forwardType === "remote" ? "←" : "→"}</span>
                    <code>{formatForwardTarget(forward)}</code>
                  </div>
                  <span title={forward.error ?? undefined}>{forward.error || routeDescription(forward.forwardType)}</span>
                </div>
                <span className="tunnelElapsedCell">{formatElapsedSince(forward.startedAt, now)}</span>
                <Tooltip title={forward.status === "failed" ? forward.error || "隧道启动失败" : undefined}>
                  <span className={`tunnelStatePill is-${forward.status}`}>{forwardStatusLabel(forward.status)}</span>
                </Tooltip>
                <div className="tunnelRowActions">
                  <Tooltip title="复制监听地址">
                    <Button
                      aria-label="复制监听地址"
                      size="small"
                      className="tunnelRowActionButton"
                      icon={<CopyOutlined />}
                      onClick={() => void copyBindAddress(forward)}
                    />
                  </Tooltip>
                  <Tooltip title={forward.status === "failed" ? "重试停止异常实例" : "停止隧道"}>
                    <Button
                      aria-label={forward.status === "failed" ? "重试停止异常实例" : "停止隧道"}
                      size="small"
                      danger
                      className="tunnelRowActionButton is-danger"
                      icon={<StopOutlined />}
                      loading={operationKey === `stop:${forward.forwardId}`}
                      disabled={operationKey !== null && operationKey !== `stop:${forward.forwardId}`}
                      onClick={() => void stopForward(forward)}
                    />
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <Modal
        className="tunnelModal"
        title={
          <div className="tunnelModalTitlebar">
            <span className="tunnelModalTitleIcon" aria-hidden="true"><NodeIndexOutlined /></span>
            <div className="tunnelModalTitleCopy">
              <strong>SSH 隧道</strong>
              <span>集中管理转发模板、监听地址与运行状态</span>
            </div>
            <div className={`tunnelModalHeaderStatus is-${healthMode}`} aria-live="polite">
              {healthMode === "active" ? <CheckCircleOutlined /> : healthMode === "warning" ? <WarningOutlined /> : <ClockCircleOutlined />}
              <span>{headerStatusText}</span>
            </div>
          </div>
        }
        open={open}
        onCancel={onClose}
        width={1120}
        footer={null}
        destroyOnHidden
        centered
      >
        <div className="tunnelLayout">
          <aside className="tunnelSidebar">
            <div className="tunnelSidebarLabel">隧道概览</div>

            <div className={`tunnelHealthCard is-${healthMode}`}>
              <div className="tunnelHealthHead">
                <span className="tunnelHealthIcon" aria-hidden="true">
                  {healthMode === "active" ? <SwapOutlined /> : healthMode === "warning" ? <WarningOutlined /> : <ClockCircleOutlined />}
                </span>
                <div>
                  <strong>{healthTitle}</strong>
                  <span>{healthDetail}</span>
                </div>
              </div>
              <div className="tunnelHealthDivider" />
              <div className="tunnelHealthRow"><span>活动隧道</span><strong>{activeForwards.length} 条</strong></div>
              <div className="tunnelHealthRow"><span>当前会话</span><strong title={healthSession}>{healthSession}</strong></div>
              <div className="tunnelHealthRow"><span>累计运行</span><strong>{primaryForward ? formatElapsedSince(primaryForward.startedAt, now) : "--:--:--"}</strong></div>
            </div>

            <div className="tunnelMetricGrid">
              <div className="tunnelMetricCard"><span>隧道模板</span><strong>{tunnels.length} 个</strong></div>
              <div className="tunnelMetricCard"><span>活动监听</span><strong>{primaryForward ? primaryForward.bindPort : "--"}</strong></div>
            </div>

            <div className="tunnelSidebarLabel">快速创建</div>
            <div className="tunnelQuickTypes">
              <button type="button" className="tunnelQuickType" onClick={() => openCreate("local")}>
                <span className="tunnelQuickTypeIcon"><ArrowRightOutlined /></span>
                <span className="tunnelQuickTypeCopy"><strong>本地转发</strong><small>本机端口访问远程服务</small></span>
                <span className="tunnelQuickTypeArrow">›</span>
              </button>
              <button type="button" className="tunnelQuickType" onClick={() => openCreate("remote")}>
                <span className="tunnelQuickTypeIcon"><ArrowLeftOutlined /></span>
                <span className="tunnelQuickTypeCopy"><strong>远程转发</strong><small>远程端口访问本地服务</small></span>
                <span className="tunnelQuickTypeArrow">›</span>
              </button>
              <button type="button" className="tunnelQuickType" onClick={() => openCreate("dynamic")}>
                <span className="tunnelQuickTypeIcon"><ShareAltOutlined /></span>
                <span className="tunnelQuickTypeCopy"><strong>动态代理</strong><small>创建本地 SOCKS5 代理</small></span>
                <span className="tunnelQuickTypeArrow">›</span>
              </button>
            </div>

            <div className="tunnelSecurityNote">
              <span aria-hidden="true"><SafetyCertificateOutlined /></span>
              <p>隧道仅在本机监听，关闭会话时可选择同步停止。</p>
            </div>
          </aside>

          <main className="tunnelWorkspace">
            <div className="tunnelWorkspaceHead">
              <div className="tunnelWorkspaceCopy">
                <strong>隧道工作区</strong>
                <span>模板与运行实例分开管理，状态更清晰</span>
              </div>
              <Segmented
                block
                className="tunnelWorkspaceTabs"
                value={activeView}
                options={[
                  { label: <span>隧道模板 <b>{tunnels.length}</b></span>, value: "templates" },
                  { label: <span>运行中 <b>{forwards.length}</b></span>, value: "running" },
                ]}
                onChange={(value) => setActiveView(value as TunnelView)}
              />
            </div>

            <section className="tunnelListCard">
              <div className="tunnelListToolbar">
                <div className="tunnelListHeading">
                  <strong>{activeView === "templates" ? "隧道模板" : "运行实例"}</strong>
                  <span>{activeView === "templates" ? tunnels.length : forwards.length}</span>
                  {(activeView === "templates" ? filteredTunnels.length !== tunnels.length : filteredForwards.length !== forwards.length) && (
                    <small>显示 {activeView === "templates" ? filteredTunnels.length : filteredForwards.length} 条</small>
                  )}
                </div>
                <div className="tunnelToolbarActions">
                  <Input
                    allowClear
                    value={query}
                    prefix={<SearchOutlined />}
                    placeholder="搜索名称或路由"
                    aria-label="搜索隧道"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <Select<TunnelTypeFilter>
                    value={typeFilter}
                    aria-label="筛选隧道类型"
                    options={[
                      { label: "全部类型", value: "all" },
                      { label: "本地转发", value: "local" },
                      { label: "远程转发", value: "remote" },
                      { label: "动态代理", value: "dynamic" },
                    ]}
                    onChange={setTypeFilter}
                  />
                  <Button className="tunnelCreateButton" type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
                    新建隧道
                  </Button>
                </div>
              </div>

              <div className="tunnelTableFrame">
                {activeView === "templates" ? renderTemplateRows() : renderRunningRows()}
              </div>

              <div className="tunnelListFooter">
                <span>
                  {activeView === "templates"
                    ? `共 ${tunnels.length} 个模板 · 双击未运行模板可快速启动`
                    : `共 ${forwards.length} 个运行实例`}
                </span>
                <span>监听地址点击后可复制</span>
              </div>
            </section>

            {primaryForward && (
              <section className="tunnelRunningStrip">
                <div className="tunnelRunningMain">
                  <span className="tunnelRunningIcon" aria-hidden="true"><SwapOutlined /></span>
                  <div className="tunnelRunningCopy">
                    <strong>{sessionNameById.get(primaryForward.sessionId) ?? "SSH 隧道"}正在运行</strong>
                    <div>
                      <button type="button" onClick={() => void copyBindAddress(primaryForward)}>{formatEndpoint(primaryForward.bindHost, primaryForward.bindPort)}</button>
                      <span>{primaryForward.forwardType === "remote" ? "←" : "→"}</span>
                      <code>{formatForwardTarget(primaryForward)}</code>
                    </div>
                  </div>
                </div>
                <div className="tunnelRunningActions">
                  <div><span>当前会话</span><strong>{sessionNameById.get(primaryForward.sessionId) ?? "未知会话"}</strong></div>
                  <div><span>运行时长</span><strong>{formatElapsedSince(primaryForward.startedAt, now)}</strong></div>
                  <Button
                    danger
                    className="tunnelStopButton"
                    icon={<StopOutlined />}
                    loading={operationKey === `stop:${primaryForward.forwardId}`}
                    disabled={operationKey !== null && operationKey !== `stop:${primaryForward.forwardId}`}
                    onClick={() => void stopForward(primaryForward)}
                  >
                    停止隧道
                  </Button>
                </div>
              </section>
            )}
          </main>
        </div>
      </Modal>
      <TunnelConfigModal
        state={editing}
        sessions={sessions}
        onCancel={() => setEditing(null)}
        onSubmit={async (input) => {
          const request = editingRef.current;
          if (!request) return;
          if (request.mode === "edit") {
            await onUpdate(request.value.id, input);
          } else {
            await onCreate(input);
          }
          if (mountedRef.current && editingRef.current?.requestId === request.requestId) setEditing(null);
        }}
      />
    </>
  );
}

function TunnelConfigModal({
  state,
  sessions,
  onCancel,
  onSubmit,
}: {
  state: TunnelModalState | null;
  sessions: RemoteSession[];
  onCancel: () => void;
  onSubmit: (input: TunnelInput) => Promise<void>;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<TunnelInput>();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const mountedRef = useMountedRef();
  const stateRequestIdRef = useRef(state?.requestId);
  stateRequestIdRef.current = state?.requestId;
  const watchedName = Form.useWatch("name", form);
  const watchedSessionId = Form.useWatch("sessionId", form);
  const watchedForwardType = Form.useWatch("forwardType", form);
  const watchedBindHost = Form.useWatch("bindHost", form);
  const watchedBindPort = Form.useWatch("bindPort", form);
  const watchedTargetHost = Form.useWatch("targetHost", form);
  const watchedTargetPort = Form.useWatch("targetPort", form);

  const forwardType: TunnelInput["forwardType"] = watchedForwardType
    ?? (state?.mode === "edit" ? state.value.forwardType : state?.initialType)
    ?? "local";
  const typeMeta = tunnelConfigTypeMeta(forwardType);
  const selectedSession = sessions.find((session) => session.id === watchedSessionId);
  const previewName = watchedName?.trim() || (state?.mode === "edit" ? state.value.name : "未命名隧道");
  const previewBindHost = watchedBindHost?.trim() || "127.0.0.1";
  const previewBindPort = typeof watchedBindPort === "number"
    ? watchedBindPort
    : forwardType === "dynamic" ? 1080 : 8080;
  const previewTargetHost = watchedTargetHost?.trim() || "127.0.0.1";
  const previewTargetPort = typeof watchedTargetPort === "number" ? watchedTargetPort : 22;
  const hasBasicInfo = Boolean(watchedName?.trim() && watchedSessionId);
  const hasListener = Boolean(watchedBindHost?.trim())
    && typeof watchedBindPort === "number"
    && watchedBindPort >= 1
    && watchedBindPort <= 65535;
  const hasTarget = forwardType === "dynamic" || (
    Boolean(watchedTargetHost?.trim())
    && typeof watchedTargetPort === "number"
    && watchedTargetPort >= 1
    && watchedTargetPort <= 65535
  );
  const completedSteps = [hasBasicInfo, hasListener, hasTarget].filter(Boolean).length;
  const previewTarget = forwardType === "dynamic"
    ? "按请求动态选择"
    : formatEndpoint(previewTargetHost, previewTargetPort);

  useEffect(() => {
    if (!state) {
      form.resetFields();
      setSubmitting(submittingRef.current);
      return;
    }
    setSubmitting(submittingRef.current);
    form.resetFields();
    if (state.mode === "edit") {
      form.setFieldsValue(state.value);
    } else {
      const initialForwardType = state.initialType ?? "local";
      form.setFieldsValue({
        name: "",
        sessionId: sessions[0]?.id ?? "",
        forwardType: initialForwardType,
        bindHost: "127.0.0.1",
        bindPort: initialForwardType === "dynamic" ? 1080 : 8080,
        targetHost: "127.0.0.1",
        targetPort: 22,
      });
    }
  }, [form, state]);

  useEffect(() => {
    if (!state || state.mode !== "create" || sessions.length === 0 || form.getFieldValue("sessionId")) return;
    form.setFieldValue("sessionId", sessions[0].id);
  }, [form, sessions, state]);

  async function submit(values: TunnelInput) {
    if (submittingRef.current) return;
    const requestId = state?.requestId;
    if (!requestId) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit({
        ...values,
        targetHost: values.forwardType === "dynamic" ? "SOCKS5" : values.targetHost,
        targetPort: values.forwardType === "dynamic" ? 0 : values.targetPort,
      });
      if (mountedRef.current && stateRequestIdRef.current === requestId) {
        message.success(state?.mode === "edit" ? "隧道配置已更新" : "隧道模板已创建");
      }
    } catch (error) {
      if (mountedRef.current && stateRequestIdRef.current === requestId) message.error(getErrorMessage(error));
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }

  function cancel() {
    if (!submitting) onCancel();
  }

  return (
    <Modal
      open={Boolean(state)}
      className="tunnelConfigModal"
      title={
        <div className="tunnelConfigTitlebar">
          <span className="tunnelConfigTitleIcon" aria-hidden="true"><NodeIndexOutlined /></span>
          <div className="tunnelConfigTitleCopy">
            <strong>{state?.mode === "edit" ? "编辑隧道" : "新建隧道"}</strong>
            <span>配置监听入口、转发方向与目标地址</span>
          </div>
          <span className={`tunnelConfigHeaderType is-${forwardType}`}>
            {forwardType === "local" ? <ArrowRightOutlined /> : forwardType === "remote" ? <ArrowLeftOutlined /> : <ShareAltOutlined />}
            {typeMeta.label}
          </span>
        </div>
      }
      footer={null}
      onCancel={cancel}
      destroyOnHidden
      width={920}
      centered
      closable={!submitting}
      keyboard={!submitting}
      mask={{ closable: !submitting }}
    >
      <div className="tunnelConfigLayout">
        <aside className="tunnelConfigSidebar">
          <div className="tunnelConfigSidebarLabel">路由预览</div>
          <div className={`tunnelConfigPreview is-${forwardType}`} aria-live="polite">
            <div className="tunnelConfigPreviewHead">
              <span className="tunnelConfigPreviewIcon" aria-hidden="true">
                {forwardType === "local" ? <ArrowRightOutlined /> : forwardType === "remote" ? <ArrowLeftOutlined /> : <ShareAltOutlined />}
              </span>
              <div>
                <strong title={previewName}>{previewName}</strong>
                <span>{selectedSession?.name ?? "尚未选择 SSH 会话"}</span>
              </div>
            </div>
            <div className="tunnelConfigPreviewRoute">
              <div className="tunnelConfigPreviewEndpoint">
                <span>{typeMeta.listenerTitle}</span>
                <code>{formatEndpoint(previewBindHost, previewBindPort)}</code>
              </div>
              <span className="tunnelConfigPreviewArrow" aria-hidden="true">
                <ArrowRightOutlined />
              </span>
              <div className="tunnelConfigPreviewEndpoint">
                <span>{typeMeta.targetTitle}</span>
                <code>{previewTarget}</code>
              </div>
            </div>
            <p>{typeMeta.description}</p>
          </div>

          <div className="tunnelConfigSidebarLabel">配置进度</div>
          <div className="tunnelConfigSteps">
            <div className={`tunnelConfigStep ${hasBasicInfo ? "is-complete" : ""}`}>
              <span className="tunnelConfigStepIndex">01</span>
              <div><strong>基本信息</strong><small>{hasBasicInfo ? `${selectedSession?.name ?? "已选会话"} · ${previewName}` : "填写名称并关联会话"}</small></div>
              {hasBasicInfo && <CheckCircleOutlined />}
            </div>
            <div className={`tunnelConfigStep ${hasListener ? "is-complete" : ""}`}>
              <span className="tunnelConfigStepIndex">02</span>
              <div><strong>{typeMeta.listenerTitle}</strong><small>{hasListener ? formatEndpoint(previewBindHost, previewBindPort) : "设置监听地址和端口"}</small></div>
              {hasListener && <CheckCircleOutlined />}
            </div>
            <div className={`tunnelConfigStep ${hasTarget ? "is-complete" : ""}`}>
              <span className="tunnelConfigStepIndex">03</span>
              <div><strong>{typeMeta.targetTitle}</strong><small>{hasTarget ? previewTarget : "填写转发目标"}</small></div>
              {hasTarget && <CheckCircleOutlined />}
            </div>
          </div>

          <div className="tunnelConfigSecurityNote">
            <SafetyCertificateOutlined />
            <p>配置仅保存在本机，启动后通过已建立的 SSH 会话转发流量。</p>
          </div>
        </aside>

        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          className="tunnelConfigWorkspace"
          disabled={submitting}
          onFinish={(values) => void submit(values)}
        >
          <div className="tunnelConfigScroll">
            <section className="tunnelConfigPanel">
              <div className="tunnelConfigPanelHead">
                <span className="tunnelConfigPanelIcon" aria-hidden="true"><TagOutlined /></span>
                <div><strong>基础配置</strong><span>用于识别隧道并指定承载转发的 SSH 会话</span></div>
              </div>
              <div className="tunnelConfigFieldGrid">
                <Form.Item label="隧道名称" name="name" rules={[{ required: true, message: "请输入隧道名称" }]}>
                  <Input placeholder="例如：数据库访问" autoFocus />
                </Form.Item>
                <Form.Item label="关联会话" name="sessionId" rules={[{ required: true, message: "请选择会话" }]}>
                  <Select
                    placeholder="选择 SSH 会话"
                    options={sessions.map((session) => ({ label: session.name, value: session.id }))}
                    showSearch
                    optionFilterProp="label"
                    notFoundContent="暂无可用会话"
                  />
                </Form.Item>
              </div>
              <div className="tunnelConfigTypeBlock">
                <div className="tunnelConfigFieldLabel"><span>转发类型</span><small>{typeMeta.description}</small></div>
                <Form.Item name="forwardType" noStyle>
                  <Segmented
                    block
                    className={`tunnelConfigTypeSegment is-${forwardType}`}
                    aria-label="选择转发类型"
                    options={[
                      {
                        label: (
                          <span className="tunnelConfigTypeOption is-local" title="本地端口访问远程服务">
                            <span className="tunnelConfigTypeOptionIcon" aria-hidden="true"><ArrowRightOutlined /></span>
                            <span className="tunnelConfigTypeOptionCopy"><strong>本地转发</strong><small>本机访问远程</small></span>
                            <span className="tunnelConfigTypeOptionCheck" aria-hidden="true"><CheckCircleOutlined /></span>
                          </span>
                        ),
                        value: "local",
                      },
                      {
                        label: (
                          <span className="tunnelConfigTypeOption is-remote" title="远程端口访问本机服务">
                            <span className="tunnelConfigTypeOptionIcon" aria-hidden="true"><ArrowLeftOutlined /></span>
                            <span className="tunnelConfigTypeOptionCopy"><strong>远程转发</strong><small>远程访问本机</small></span>
                            <span className="tunnelConfigTypeOptionCheck" aria-hidden="true"><CheckCircleOutlined /></span>
                          </span>
                        ),
                        value: "remote",
                      },
                      {
                        label: (
                          <span className="tunnelConfigTypeOption is-dynamic" title="创建本机 SOCKS5 动态代理">
                            <span className="tunnelConfigTypeOptionIcon" aria-hidden="true"><ShareAltOutlined /></span>
                            <span className="tunnelConfigTypeOptionCopy"><strong>动态代理</strong><small>SOCKS5 代理</small></span>
                            <span className="tunnelConfigTypeOptionCheck" aria-hidden="true"><CheckCircleOutlined /></span>
                          </span>
                        ),
                        value: "dynamic",
                      },
                    ]}
                  />
                </Form.Item>
              </div>
            </section>

            <section className="tunnelConfigPanel">
              <div className="tunnelConfigPanelHead">
                <span className="tunnelConfigPanelIcon" aria-hidden="true"><NodeIndexOutlined /></span>
                <div><strong>路由设置</strong><span>定义客户端入口以及流量最终到达的位置</span></div>
                <span className={`tunnelConfigDirectionBadge is-${forwardType}`}><SwapOutlined />{typeMeta.directionLabel}</span>
              </div>

              <div className={`tunnelConfigRouteEditor is-${forwardType}`}>
                <div className="tunnelConfigEndpointCard">
                  <div className="tunnelConfigEndpointHead">
                    <span><NodeIndexOutlined /></span>
                    <div><strong>{typeMeta.listenerTitle}</strong><small>{typeMeta.listenerHint}</small></div>
                  </div>
                  <div className="tunnelConfigEndpointFields">
                    <Form.Item label="监听地址" name="bindHost" rules={[{ required: true, message: "请输入监听地址" }]}>
                      <Input placeholder="127.0.0.1" />
                    </Form.Item>
                    <Form.Item
                      label="端口"
                      name="bindPort"
                      rules={[
                        { required: true, message: "请输入监听端口" },
                        { type: "number", min: 1, max: 65535, message: "监听端口范围为 1-65535" },
                      ]}
                      tooltip="端口范围为 1-65535，不支持 0 或自动分配"
                    >
                      <InputNumber min={1} max={65535} precision={0} controls={false} style={{ width: "100%" }} />
                    </Form.Item>
                  </div>
                </div>

                <div className="tunnelConfigRouteDirection" aria-hidden="true">
                  <span>{forwardType === "remote" ? <ArrowLeftOutlined /> : <ArrowRightOutlined />}</span>
                  <small>{forwardType === "dynamic" ? "代理" : "转发"}</small>
                </div>

                {forwardType === "dynamic" ? (
                  <div className="tunnelConfigEndpointCard is-dynamic">
                    <div className="tunnelConfigEndpointHead">
                      <span><GlobalOutlined /></span>
                      <div><strong>动态目标</strong><small>由每个 SOCKS5 请求指定</small></div>
                    </div>
                    <div className="tunnelConfigDynamicTarget">
                      <ShareAltOutlined />
                      <div><strong>SOCKS5 动态路由</strong><span>无需填写固定目标，浏览器或应用会在连接时提供目标地址。</span></div>
                    </div>
                  </div>
                ) : (
                  <div className="tunnelConfigEndpointCard">
                    <div className="tunnelConfigEndpointHead">
                      <span><GlobalOutlined /></span>
                      <div><strong>{typeMeta.targetTitle}</strong><small>{typeMeta.targetHint}</small></div>
                    </div>
                    <div className="tunnelConfigEndpointFields">
                      <Form.Item label="目标地址" name="targetHost" rules={[{ required: true, message: "请输入目标地址" }]}>
                        <Input placeholder="127.0.0.1 或主机名" />
                      </Form.Item>
                      <Form.Item
                        label="端口"
                        name="targetPort"
                        rules={[
                          { required: true, message: "请输入目标端口" },
                          { type: "number", min: 1, max: 65535, message: "目标端口范围为 1-65535" },
                        ]}
                      >
                        <InputNumber min={1} max={65535} precision={0} controls={false} style={{ width: "100%" }} />
                      </Form.Item>
                    </div>
                  </div>
                )}
              </div>

              <div className="tunnelConfigRouteHint">
                <LinkOutlined />
                <span>{typeMeta.routeHint}</span>
              </div>
            </section>
          </div>

          <div className="tunnelConfigFooter">
            <div className={`tunnelConfigFooterState ${completedSteps === 3 ? "is-ready" : ""}`}>
              {completedSteps === 3 ? <CheckCircleOutlined /> : <ClockCircleOutlined />}
              <span>{completedSteps === 3 ? "配置完整，可以提交" : `已完成 ${completedSteps}/3 项配置`}</span>
            </div>
            <div className="tunnelConfigFooterActions">
              <Button disabled={submitting} onClick={cancel}>取消</Button>
              <Button type="primary" htmlType="submit" loading={submitting}>
                {state?.mode === "edit" ? "保存修改" : "创建隧道"}
              </Button>
            </div>
          </div>
        </Form>
      </div>
    </Modal>
  );
}

function tunnelConfigTypeMeta(type: TunnelInput["forwardType"]) {
  if (type === "remote") {
    return {
      label: "远程转发",
      description: "在 SSH 服务器侧开放端口，并把访问转发到本机可达的服务。",
      listenerTitle: "远程监听",
      listenerHint: "SSH 服务器侧开放入口",
      targetTitle: "本地目标",
      targetHint: "由当前客户端访问",
      directionLabel: "服务器 → 本机",
      routeHint: "远程主机访问监听端口后，流量会通过 SSH 会话回传到本地目标。",
    };
  }
  if (type === "dynamic") {
    return {
      label: "动态代理",
      description: "在本机创建 SOCKS5 代理，由客户端请求动态决定最终目标。",
      listenerTitle: "本机代理入口",
      listenerHint: "应用连接的 SOCKS5 地址",
      targetTitle: "动态目标",
      targetHint: "由每次请求指定",
      directionLabel: "SOCKS5 动态路由",
      routeHint: "把浏览器或应用的代理地址设置为监听地址，即可通过 SSH 会话访问目标站点。",
    };
  }
  return {
    label: "本地转发",
    description: "在本机开放端口，并把访问转发到 SSH 服务器可达的目标。",
    listenerTitle: "本机监听",
    listenerHint: "客户端连接入口",
    targetTitle: "远程目标",
    targetHint: "由 SSH 服务器侧访问",
    directionLabel: "本机 → 远程",
    routeHint: "连接本机监听地址后，流量会通过 SSH 会话抵达远程目标。",
  };
}

function forwardExactKey(forward: ForwardInfo) {
  return forwardKey(
    forward.sessionId,
    forward.forwardType,
    forward.bindHost,
    forward.bindPort,
    forward.targetHost,
    forward.targetPort,
  );
}

function tunnelExactKey(tunnel: TunnelConfig) {
  return forwardKey(
    tunnel.sessionId,
    tunnel.forwardType,
    tunnel.bindHost,
    tunnel.bindPort,
    tunnel.targetHost,
    tunnel.targetPort,
  );
}

function forwardAutoPortKey(forward: ForwardInfo) {
  return forwardKey(
    forward.sessionId,
    forward.forwardType,
    forward.bindHost,
    0,
    forward.targetHost,
    forward.targetPort,
  );
}

function tunnelAutoPortKey(tunnel: TunnelConfig) {
  return forwardKey(
    tunnel.sessionId,
    tunnel.forwardType,
    tunnel.bindHost,
    0,
    tunnel.targetHost,
    tunnel.targetPort,
  );
}

function forwardKey(
  sessionId: string,
  forwardType: TunnelConfig["forwardType"] | ForwardInfo["forwardType"],
  bindHost: string,
  bindPort: number,
  targetHost: string,
  targetPort: number,
) {
  if (forwardType === "dynamic") {
    return [sessionId, forwardType, bindHost, bindPort].join("\0");
  }
  return [sessionId, forwardType, bindHost, bindPort, targetHost, targetPort].join("\0");
}

function forwardTypeLabel(type: TunnelConfig["forwardType"] | ForwardInfo["forwardType"]) {
  if (type === "local") return "本地";
  if (type === "remote") return "远端";
  return "动态";
}

function forwardTypeDescription(type: TunnelConfig["forwardType"] | ForwardInfo["forwardType"]) {
  if (type === "local") return "本机端口访问远程服务";
  if (type === "remote") return "远程端口访问本地服务";
  return "通过 SSH 创建 SOCKS5 代理";
}

function routeDescription(type: TunnelConfig["forwardType"] | ForwardInfo["forwardType"]) {
  if (type === "local") return "仅本机可访问";
  if (type === "remote") return "从服务器端访问";
  return "按请求动态选择目标";
}

function formatEndpoint(host: string, port: number) {
  return `${host}:${port === 0 ? "自动" : port}`;
}

function formatTunnelTarget(tunnel: TunnelConfig) {
  return tunnel.forwardType === "dynamic" ? "SOCKS5" : formatEndpoint(tunnel.targetHost, tunnel.targetPort);
}

function formatForwardTarget(forward: ForwardInfo) {
  return forward.forwardType === "dynamic" ? "SOCKS5" : formatEndpoint(forward.targetHost, forward.targetPort);
}

function isForwardActive(forward: ForwardInfo) {
  return forward.status === "queued" || forward.status === "running";
}

function forwardStatusRank(status: ForwardInfo["status"]) {
  if (status === "running") return 0;
  if (status === "queued") return 1;
  if (status === "failed") return 2;
  if (status === "canceled") return 3;
  return 4;
}

function forwardStatusLabel(status: ForwardInfo["status"]) {
  if (status === "queued") return "启动中";
  if (status === "running") return "运行中";
  if (status === "failed") return "启动失败";
  if (status === "canceled") return "已取消";
  return "已停止";
}

function templateState(forward?: ForwardInfo): ForwardInfo["status"] | "idle" {
  return forward?.status ?? "idle";
}
