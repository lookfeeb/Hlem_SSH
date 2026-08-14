import {
  BorderOutlined,
  CloseOutlined,
  FullscreenExitOutlined,
  LeftOutlined,
  MinusOutlined,
  ProfileOutlined,
  RightOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { App as AntdApp, Badge, Button, Space, Tooltip } from "antd";
import { isTauriRuntime } from "../api/runtime";
import type { ConnectionState, RemoteSession, TransferInfo } from "../types";

interface TopBarProps {
  tabSessions: RemoteSession[];
  activeSessionId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onConnect: (session: RemoteSession) => void;
  onDisconnect: (session: RemoteSession) => void;
  onCancelConnect: (id: string) => void;
  onTransferOpen: () => void;
  onSettingsOpen: () => void;
  connectingSessionIds: ReadonlySet<string>;
  transfers: TransferInfo[];
  apiServerRunning: boolean;
  apiConfigured: boolean;
  onApiServerStart: () => void;
}

export function TopBar({
  tabSessions,
  activeSessionId,
  onActivate,
  onClose,
  onConnect,
  onDisconnect,
  onCancelConnect,
  onTransferOpen,
  onSettingsOpen,
  connectingSessionIds,
  transfers,
  apiServerRunning,
  apiConfigured,
  onApiServerStart,
}: TopBarProps) {
  const { modal } = AntdApp.useApp();
  const activeTransferTotal = activeTransferCount(transfers);
  const tabsViewportRef = useRef<HTMLDivElement>(null);
  const disconnectConfirmationRef = useRef<string | null>(null);
  const [tabScrollState, setTabScrollState] = useState({ canLeft: false, canRight: false });
  const [mainWindowMaximized, setMainWindowMaximized] = useState(false);
  const tabsScrollable = tabScrollState.canLeft || tabScrollState.canRight;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const currentWindow = getCurrentWindow();
        const syncMaximizedState = async () => {
          try {
            const maximized = await currentWindow.isMaximized();
            if (!disposed) setMainWindowMaximized(maximized);
          } catch (error) {
            console.warn("[helm] failed to read main window state:", error);
          }
        };
        const cleanup = await currentWindow.onResized(() => void syncMaximizedState());
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        await syncMaximizedState();
      })
      .catch((error) => console.warn("[helm] failed to observe main window state:", error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  function shouldDragWindow(target: EventTarget | null) {
    return !(target instanceof Element && target.closest("button, a, input, textarea, select, [role=\"tab\"], .sessionTabsViewport"));
  }

  function handleWindowMouseDown(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0 || !shouldDragWindow(event.target) || !isTauriRuntime()) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
      .catch((error) => console.warn("[helm] failed to drag main window:", error));
  }

  async function minimizeMainWindow() {
    try {
      if (isTauriRuntime()) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().minimize();
      } else {
        window.blur();
      }
    } catch (error) {
      console.warn("[helm] failed to minimize main window:", error);
    }
  }

  async function toggleMainWindowMaximize() {
    try {
      if (isTauriRuntime()) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().toggleMaximize();
        setMainWindowMaximized(await getCurrentWindow().isMaximized());
      }
    } catch (error) {
      console.warn("[helm] failed to toggle main window maximize:", error);
    }
  }

  async function closeMainWindow() {
    try {
      if (isTauriRuntime()) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      } else {
        window.close();
      }
    } catch (error) {
      console.warn("[helm] failed to close main window:", error);
    }
  }

  const updateTabScrollState = useCallback(() => {
    const element = tabsViewportRef.current;
    if (!element) {
      setTabScrollState({ canLeft: false, canRight: false });
      return;
    }
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    const next = {
      canLeft: element.scrollLeft > 1,
      canRight: element.scrollLeft < maxScrollLeft - 1,
    };
    setTabScrollState((current) =>
      current.canLeft === next.canLeft && current.canRight === next.canRight ? current : next,
    );
  }, []);

  useEffect(() => {
    const element = tabsViewportRef.current;
    if (!element) return;
    updateTabScrollState();
    const list = element.firstElementChild;
    const observer = new ResizeObserver(updateTabScrollState);
    observer.observe(element);
    if (list) observer.observe(list);
    element.addEventListener("scroll", updateTabScrollState, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", updateTabScrollState);
    };
  }, [tabSessions.length, updateTabScrollState]);

  useEffect(() => {
    const element = tabsViewportRef.current?.querySelector(".sessionTab-active");
    if (!(element instanceof HTMLElement)) return;
    element.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    const frame = window.requestAnimationFrame(updateTabScrollState);
    return () => window.cancelAnimationFrame(frame);
  }, [activeSessionId, tabSessions.length, updateTabScrollState]);

  const scrollSessionTabs = useCallback((direction: -1 | 1) => {
    const element = tabsViewportRef.current;
    if (!element) return;
    const distance = Math.max(160, Math.floor(element.clientWidth * 0.72));
    element.scrollBy({ left: direction * distance, behavior: "smooth" });
  }, []);

  const handleSessionTabClick = useCallback((session: RemoteSession) => {
    if (session.id !== activeSessionId) {
      onActivate(session.id);
      return;
    }
    const state = sessionState(session, connectingSessionIds);
    if (state === "connected") {
      if (disconnectConfirmationRef.current === session.id) return;
      disconnectConfirmationRef.current = session.id;
      const clearConfirmation = () => {
        if (disconnectConfirmationRef.current === session.id) {
          disconnectConfirmationRef.current = null;
        }
      };
      modal.confirm({
        title: "断开 SSH 连接？",
        content: `确定要断开“${session.name}”吗？`,
        okText: "断开连接",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: () => {
          clearConfirmation();
          onDisconnect(session);
        },
        onCancel: clearConfirmation,
        afterClose: clearConfirmation,
      });
    } else if (state === "connecting") {
      onCancelConnect(session.id);
    } else if (state === "disconnected" || state === "failed") {
      onConnect(session);
    }
  }, [activeSessionId, connectingSessionIds, modal, onActivate, onCancelConnect, onConnect, onDisconnect]);

  return (
    <header className="topBar" onMouseDown={handleWindowMouseDown}>
      <div className="brand">
        <span className="brandMark">
          <img className="brandIcon" src="./Helm_icon.svg" alt="" aria-hidden="true" />
          <span>HelM</span>
        </span>
        <Space size={6} className="brandActions">
          {apiConfigured && (
            <Tooltip title={apiServerRunning ? "AI API 运行中" : "AI API 已停止"} placement="bottom">
              <Button
                aria-label="AI API"
                className={`brandApiButton${apiServerRunning ? " brandApiButton-running" : " brandApiButton-stopped"}`}
                icon={<ThunderboltOutlined />}
                size="small"
                onClick={onApiServerStart}
              />
            </Tooltip>
          )}
          <Tooltip title="设置" placement="bottom">
            <Button
              aria-label="设置"
              icon={<SettingOutlined />}
              size="small"
              onClick={onSettingsOpen}
            />
          </Tooltip>
        </Space>
      </div>
      <div className={`sessionTabs${tabsScrollable ? " sessionTabs-scrollable" : ""}`}>
        <Button
          aria-label="向左滚动标签"
          className="sessionTabsScrollButton sessionTabsScrollButton-left"
          disabled={!tabScrollState.canLeft}
          icon={<LeftOutlined />}
          size="small"
          onClick={() => scrollSessionTabs(-1)}
        />
        <div className="sessionTabsViewport" ref={tabsViewportRef}>
          <div className="sessionTabsList" role="tablist" aria-orientation="horizontal">
            {tabSessions.map((session) => {
              const state = sessionState(session, connectingSessionIds);
              const stateText = sessionStateText(state);
              const active = session.id === activeSessionId;
              return (
                <div
                  key={session.id}
                  className={`sessionTab sessionTab-${state}${active ? " sessionTab-active" : ""}`}
                  role="presentation"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={`${stateText}：${session.name}`}
                    className="sessionTabButton"
                    title={`${stateText}：${session.name}`}
                    onClick={() => handleSessionTabClick(session)}
                  >
                    <span className={`sessionTabLabel sessionTabLabel-${state}`}>
                      <span className={`sessionTabState sessionTabState-${state}`} aria-hidden="true" />
                      <span className="sessionTabName">{session.name}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`关闭 ${session.name}`}
                    className="sessionTabClose"
                    onClick={() => onClose(session.id)}
                  >
                    <CloseOutlined />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <Button
          aria-label="向右滚动标签"
          className="sessionTabsScrollButton sessionTabsScrollButton-right"
          disabled={!tabScrollState.canRight}
          icon={<RightOutlined />}
          size="small"
          onClick={() => scrollSessionTabs(1)}
        />
      </div>

      <div className="topBarRight">
        <Space size={4} className="toolbar">
          <Tooltip title={activeTransferTotal > 0 ? `传输进行中 · ${activeTransferTotal} 条` : "传输列表"} placement="bottom">
            <Badge size="small" count={activeTransferTotal} offset={[-2, 2]}>
              <Button
                aria-label="传输列表"
                className={activeTransferTotal > 0 ? "transferToolbarButton transferToolbarButton-active" : "transferToolbarButton"}
                icon={<ProfileOutlined />}
                size="small"
                onClick={onTransferOpen}
              />
            </Badge>
          </Tooltip>
        </Space>
        <div className="mainWindowControls" aria-label="窗口控制">
          <button
            type="button"
            className="mainWindowControl"
            aria-label="最小化"
            title="最小化"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void minimizeMainWindow()}
          >
            <MinusOutlined />
          </button>
          <button
            type="button"
            className="mainWindowControl"
            aria-label={mainWindowMaximized ? "还原窗口" : "最大化"}
            title={mainWindowMaximized ? "还原窗口" : "最大化"}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void toggleMainWindowMaximize()}
          >
            {mainWindowMaximized ? <FullscreenExitOutlined /> : <BorderOutlined />}
          </button>
          <button
            type="button"
            className="mainWindowControl close"
            aria-label="关闭"
            title="关闭"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void closeMainWindow()}
          >
            <CloseOutlined />
          </button>
        </div>
      </div>
    </header>
  );
}

function sessionState(session: RemoteSession, connectingSessionIds: ReadonlySet<string>): ConnectionState {
  return connectingSessionIds.has(session.id) ? "connecting" : session.state;
}

function sessionStateText(state: ConnectionState) {
  switch (state) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "failed":
      return "连接失败";
    default:
      return "未连接";
  }
}

function activeTransferCount(transfers: TransferInfo[]) {
  return transfers.reduce(
    (count, transfer) => count + (transfer.status === "queued" || transfer.status === "running" || transfer.status === "paused" ? 1 : 0),
    0,
  );
}
