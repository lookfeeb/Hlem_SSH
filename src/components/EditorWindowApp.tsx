import {
  CheckCircleFilled,
  CloseCircleOutlined,
  CloseOutlined,
  CloudServerOutlined,
  DisconnectOutlined,
  ExclamationCircleFilled,
  FileTextOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  MinusOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { App as AntdApp, Button, ConfigProvider, Modal, Spin, message, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauriRuntime } from "../api/runtime";
import { EDITOR_CHANNEL_NAME, type EditorChannelMessage } from "../lib/editorChannel";
import { detectFileLanguage } from "../lib/fileLanguage";
import { getErrorMessage } from "../lib/configMapping";
import { getAnyPathBaseName } from "../lib/path";
import { useTimeoutRegistry } from "../lib/reactLifecycle";
import { detectLineEnding, detectTextEncoding } from "../lib/textFileMetadata";
import { CodeEditor } from "./CodeEditor";

interface EditorTab {
  key: string;
  path: string;
  content: string;
  originalContent: string;
  saving: boolean;
  pendingSaveId?: string;
  sessionId: string;
  sessionName: string;
  sessionHost: string;
  disconnected?: boolean;
}

function getFileName(path: string) {
  return getAnyPathBaseName(path) || path;
}

function getParentPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return "";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

function getPathSegments(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

function editorTabKey(sessionId: string, path: string) {
  return `${encodeURIComponent(sessionId)}:${encodeURIComponent(path)}`;
}

function createEditorTab(payload: { path: string; content: string; sessionId?: string; sessionName?: string; sessionHost?: string }): EditorTab {
  const sessionId = payload.sessionId ?? "";
  return {
    key: editorTabKey(sessionId, payload.path),
    path: payload.path,
    content: payload.content,
    originalContent: payload.content,
    saving: false,
    sessionId,
    sessionName: payload.sessionName ?? "",
    sessionHost: payload.sessionHost ?? "",
  };
}

function postEditorMessage(channel: BroadcastChannel, payload: EditorChannelMessage): boolean {
  try {
    channel.postMessage(payload);
    return true;
  } catch (error) {
    console.warn("[helm] failed to post editor message:", getErrorMessage(error));
    return false;
  }
}

function isTabDirty(tab: EditorTab) {
  return tab.content !== tab.originalContent;
}

function countLines(content: string) {
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function formatByteSize(content: string) {
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sessionColor(id?: string) {
  if (!id) return "#5b67e8";
  const colors = ["#5b67e8", "#159f91", "#2788d9", "#9b64d7", "#d27a35", "#c65381"];
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

export function EditorWindowApp() {
  const editorChannel = new URLSearchParams(window.location.search).get("editorWindow") ?? EDITOR_CHANNEL_NAME;
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [ready, setReady] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [closePromptKey, setClosePromptKey] = useState<string | null>(null);
  const [closeAfterSaveKey, setCloseAfterSaveKey] = useState<string | null>(null);
  const [windowClosePromptOpen, setWindowClosePromptOpen] = useState(false);
  const [windowClosing, setWindowClosing] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const tabsRef = useRef<EditorTab[]>([]);
  const dirtyTabsRef = useRef<EditorTab[]>([]);
  const closeApprovedRef = useRef(false);
  const closeAfterSaveRef = useRef<Map<string, string>>(new Map());
  const setSafeTimeout = useTimeoutRegistry();

  tabsRef.current = tabs;
  dirtyTabsRef.current = tabs.filter(isTabDirty);

  const removeTab = useCallback((targetKey: string) => {
    for (const [saveId, tabKey] of closeAfterSaveRef.current) {
      if (tabKey === targetKey) closeAfterSaveRef.current.delete(saveId);
    }
    setTabs((current) => {
      const index = current.findIndex((item) => item.key === targetKey);
      if (index < 0) return current;
      const next = current.filter((item) => item.key !== targetKey);
      setActiveKey((currentActiveKey) => (
        currentActiveKey === targetKey
          ? next[Math.min(index, next.length - 1)]?.key ?? ""
          : currentActiveKey
      ));
      return next;
    });
    setClosePromptKey((current) => current === targetKey ? null : current);
    setCloseAfterSaveKey((current) => current === targetKey ? null : current);
  }, []);

  useEffect(() => {
    const channel = new BroadcastChannel(editorChannel);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<EditorChannelMessage>) => {
      const payload = event.data;
      if (payload.type === "init") {
        const tab = createEditorTab(payload);
        setTabs([tab]);
        setActiveKey(tab.key);
        setReady(true);
      }
      if (payload.type === "addTab") {
        const tab = createEditorTab(payload);
        setTabs((current) => current.some((item) => item.key === tab.key) ? current : [...current, tab]);
        setActiveKey(tab.key);
      }
      if (payload.type === "saved") {
        const closeTargetKey = closeAfterSaveRef.current.get(payload.saveId);
        if (closeTargetKey) closeAfterSaveRef.current.delete(payload.saveId);
        setTabs((current) => current.map((tab) => (
          tab.path === payload.path && tab.sessionId === payload.sessionId && tab.pendingSaveId === payload.saveId
            ? { ...tab, saving: false, pendingSaveId: undefined, originalContent: payload.content }
            : tab
        )));
        const closeTarget = closeTargetKey
          ? tabsRef.current.find((tab) => tab.key === closeTargetKey)
          : undefined;
        const canClose = Boolean(
          closeTarget
          && closeTarget.path === payload.path
          && closeTarget.sessionId === payload.sessionId
          && closeTarget.content === payload.content,
        );
        if (closeTargetKey && canClose) removeTab(closeTargetKey);
        else if (closeTargetKey) setCloseAfterSaveKey((current) => current === closeTargetKey ? null : current);
        message.open({
          key: "editor-save",
          type: closeTargetKey && !canClose ? "warning" : "success",
          content: closeTargetKey && !canClose
            ? "文件已保存，但保存期间内容再次发生修改，标签仍保持打开"
            : closeTargetKey
              ? "文件已保存到远端并关闭"
              : "文件已保存到远端",
          duration: 2,
        });
      }
      if (payload.type === "error") {
        const closeTargetKey = payload.saveId ? closeAfterSaveRef.current.get(payload.saveId) : undefined;
        if (payload.saveId) closeAfterSaveRef.current.delete(payload.saveId);
        if (closeTargetKey) setCloseAfterSaveKey((current) => current === closeTargetKey ? null : current);
        setTabs((current) => current.map((tab) => (
          tab.path === payload.path && tab.sessionId === (payload.sessionId ?? "") && (!payload.saveId || tab.pendingSaveId === payload.saveId)
            ? { ...tab, saving: false, pendingSaveId: undefined }
            : tab
        )));
        message.error(payload.message);
      }
      if (payload.type === "sessionDisconnected") {
        const disconnectedTabKeys = new Set(
          tabsRef.current.filter((tab) => tab.sessionId === payload.sessionId).map((tab) => tab.key),
        );
        for (const [saveId, tabKey] of closeAfterSaveRef.current) {
          if (!disconnectedTabKeys.has(tabKey)) continue;
          closeAfterSaveRef.current.delete(saveId);
          setCloseAfterSaveKey((current) => current === tabKey ? null : current);
        }
        setTabs((current) => current.map((tab) => tab.sessionId === payload.sessionId
          ? { ...tab, disconnected: true, saving: false, pendingSaveId: undefined }
          : tab));
      }
      if (payload.type === "sessionReconnected") {
        setTabs((current) => current.map((tab) => tab.sessionId === payload.sessionId ? { ...tab, disconnected: false } : tab));
      }
      if (payload.type === "sessionMetadata") {
        setTabs((current) => current.map((tab) => {
          if (tab.sessionId !== payload.sessionId) return tab;
          const sessionName = payload.sessionName.trim() || tab.sessionName;
          const sessionHost = payload.sessionHost.trim() || tab.sessionHost;
          return sessionName === tab.sessionName && sessionHost === tab.sessionHost
            ? tab
            : { ...tab, sessionName, sessionHost };
        }));
      }
    };
    postEditorMessage(channel, { type: "ready" });
    const notifyClose = () => postEditorMessage(channel, { type: "close" });
    const guardBrowserClose = (event: BeforeUnloadEvent) => {
      if (isTauriRuntime() || closeApprovedRef.current || dirtyTabsRef.current.length === 0) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guardBrowserClose);
    window.addEventListener("pagehide", notifyClose);
    return () => {
      window.removeEventListener("beforeunload", guardBrowserClose);
      window.removeEventListener("pagehide", notifyClose);
      if (channelRef.current === channel) channelRef.current = null;
      channel.close();
    };
  }, [editorChannel, removeTab]);

  const openSessionIdKey = Array.from(new Set(tabs.map((tab) => tab.sessionId).filter(Boolean))).sort().join("\u0000");

  useEffect(() => {
    if (!ready || !openSessionIdKey || !channelRef.current) return;
    postEditorMessage(channelRef.current, {
      type: "requestSessionMetadata",
      sessionIds: openSessionIdKey.split("\u0000"),
    });
  }, [openSessionIdKey, ready]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (closeApprovedRef.current || dirtyTabsRef.current.length === 0) return;
        event.preventDefault();
        setWindowClosePromptOpen(true);
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => console.warn("[helm] failed to register editor close guard:", getErrorMessage(error)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const activeTab = tabs.find((tab) => tab.key === activeKey);
  const activeDirty = Boolean(activeTab && isTabDirty(activeTab));

  const activeMeta = useMemo(() => {
    if (!activeTab) return null;
    return {
      fileName: getFileName(activeTab.path),
      parentPath: getParentPath(activeTab.path),
      segments: getPathSegments(activeTab.path),
      language: detectFileLanguage(activeTab.path, activeTab.content),
      size: formatByteSize(activeTab.content),
      lines: countLines(activeTab.content),
      encoding: detectTextEncoding(activeTab.content),
      lineEnding: detectLineEnding(activeTab.content),
    };
  }, [activeTab]);

  const saveTab = useCallback((targetKey: string, closeAfterSave = false) => {
    const tab = tabsRef.current.find((item) => item.key === targetKey);
    if (!tab || tab.disconnected) return false;
    if (tab.saving) {
      if (!closeAfterSave || !tab.pendingSaveId) return false;
      closeAfterSaveRef.current.set(tab.pendingSaveId, targetKey);
      setCloseAfterSaveKey(targetKey);
      return true;
    }
    const saveId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    if (closeAfterSave) {
      closeAfterSaveRef.current.set(saveId, targetKey);
      setCloseAfterSaveKey(targetKey);
    }
    setTabs((current) => current.map((item) => item.key === targetKey ? { ...item, saving: true, pendingSaveId: saveId } : item));
    if (channelRef.current && postEditorMessage(channelRef.current, {
      type: "save",
      path: tab.path,
      content: tab.content,
      sessionId: tab.sessionId,
      saveId,
    })) return true;
    closeAfterSaveRef.current.delete(saveId);
    setCloseAfterSaveKey((current) => current === targetKey ? null : current);
    setTabs((current) => current.map((item) => item.key === targetKey ? { ...item, saving: false, pendingSaveId: undefined } : item));
    message.error("无法发送保存请求，文件仍保持打开");
    return false;
  }, []);

  const save = useCallback(() => {
    if (activeKey) saveTab(activeKey);
  }, [activeKey, saveTab]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [save]);

  function updateContent(key: string, value: string) {
    setTabs((current) => current.map((tab) => tab.key === key ? { ...tab, content: value } : tab));
  }

  function closeTab(targetKey: string) {
    const tab = tabsRef.current.find((item) => item.key === targetKey);
    if (!tab) return;
    if (isTabDirty(tab)) {
      setClosePromptKey(targetKey);
      setCloseAfterSaveKey(null);
      return;
    }
    removeTab(targetKey);
  }

  function cancelClosePrompt() {
    if (closePromptKey) {
      for (const [saveId, tabKey] of closeAfterSaveRef.current) {
        if (tabKey === closePromptKey) closeAfterSaveRef.current.delete(saveId);
      }
    }
    setClosePromptKey(null);
    setCloseAfterSaveKey(null);
  }

  async function minimizeWindow() {
    try {
      if (isTauriRuntime()) {
        await getCurrentWindow().minimize();
      } else {
        window.blur();
      }
    } catch (error) {
      message.error(`无法最小化窗口：${getErrorMessage(error)}`);
    }
  }

  async function forceCloseWindow() {
    if (windowClosing) return;
    closeApprovedRef.current = true;
    setWindowClosing(true);
    try {
      if (isTauriRuntime()) {
        await getCurrentWindow().destroy();
      } else {
        window.close();
        setSafeTimeout(() => {
          if (window.closed) return;
          closeApprovedRef.current = false;
          setWindowClosing(false);
          message.warning("浏览器阻止了窗口关闭，请使用浏览器窗口的关闭按钮");
        }, 150);
      }
    } catch (error) {
      closeApprovedRef.current = false;
      setWindowClosing(false);
      if (dirtyTabsRef.current.length > 0) setWindowClosePromptOpen(true);
      message.error(`无法关闭窗口：${getErrorMessage(error)}`);
    }
  }

  function closeWindow() {
    if (dirtyTabsRef.current.length > 0) {
      setWindowClosePromptOpen(true);
      return;
    }
    void forceCloseWindow();
  }

  function handleTitlebarMouseDown(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, input, textarea, select, [role=\"tab\"], [contenteditable=\"true\"]")) return;
    // Elements marked as native Tauri drag regions are handled by Tauri's
    // injected listener. The explicit API below covers all remaining blank
    // titlebar space, including the connection status area.
    if (target instanceof Element && target.closest("[data-tauri-drag-region]")) return;
    event.preventDefault();
    void getCurrentWindow()
      .startDragging()
      .catch((error) => console.warn("[helm] failed to drag editor window:", getErrorMessage(error)));
  }

  const workspaceClassName = [
    "detachedEditorWorkspace",
    !sidebarVisible && "editorSidebarHidden",
    !inspectorVisible && "editorInspectorHidden",
  ].filter(Boolean).join(" ");

  const activeSessionStyle = {
    "--editor-session-color": sessionColor(activeTab?.sessionId),
  } as CSSProperties;
  const closePromptTab = tabs.find((tab) => tab.key === closePromptKey);
  const closePromptSaving = Boolean(closePromptTab && closeAfterSaveKey === closePromptTab.key);
  const dirtyTabs = tabs.filter(isTabDirty);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#5b67e8",
          borderRadius: 9,
          colorBgBase: "#ffffff",
          colorTextBase: "#1d2a40",
        },
      }}
    >
      <AntdApp>
        <main className="detachedEditorWindow">
          <header className="detachedEditorTitlebar" onMouseDownCapture={handleTitlebarMouseDown}>
            <div className="detachedEditorBrand" data-tauri-drag-region>
              <span className="detachedEditorBrandMark" data-tauri-drag-region>H</span>
              <span className="detachedEditorBrandCopy" data-tauri-drag-region>
                <strong data-tauri-drag-region>HelM Editor</strong>
                <small data-tauri-drag-region>远程文件工作区</small>
              </span>
            </div>

            <div className="detachedEditorTitlebarDragSurface" data-tauri-drag-region aria-hidden="true" />

            <div className="detachedEditorWindowControls">
              <span className={`detachedEditorSyncSummary ${activeTab?.disconnected ? "disconnected" : ""}`}>
                {activeTab?.disconnected ? <DisconnectOutlined /> : <CheckCircleFilled />}
                {activeTab?.disconnected ? "连接已断开" : activeDirty ? "存在未保存修改" : "远端已同步"}
              </span>
              <button type="button" className="detachedEditorWindowButton" aria-label="最小化" title="最小化" onMouseDown={(event) => event.stopPropagation()} onClick={() => void minimizeWindow()}>
                <MinusOutlined />
              </button>
              <button type="button" className="detachedEditorWindowButton close" aria-label="关闭" title="关闭" onMouseDown={(event) => event.stopPropagation()} onClick={closeWindow}>
                <CloseOutlined />
              </button>
            </div>
          </header>

          <section className="detachedEditorCommandbar" style={activeSessionStyle}>
            <div className={`detachedEditorConnectionPill ${activeTab?.disconnected ? "disconnected" : ""}`}>
              <span className="detachedEditorConnectionDot" />
              <CloudServerOutlined />
              <strong>{activeTab?.sessionName || "等待远程会话"}</strong>
              <span>{activeTab?.disconnected ? "离线" : activeTab ? "已连接" : "未载入"}</span>
            </div>
            <div className="detachedEditorBreadcrumb" title={activeTab?.path}>
              {activeMeta?.segments.map((segment, index) => (
                <span key={`${segment}-${index}`} className={index === activeMeta.segments.length - 1 ? "current" : undefined}>
                  {index > 0 && <i>/</i>}
                  {segment}
                </span>
              ))}
              {!activeMeta && <span className="current">文件编辑器</span>}
            </div>
            <Button
              type="primary"
              className="editorPrimarySaveButton"
              aria-label="保存到远端"
              icon={<SaveOutlined />}
              loading={activeTab?.saving}
              disabled={!ready || !activeTab || activeTab.disconnected || !activeDirty}
              onClick={save}
            >
              保存到远端
            </Button>
          </section>

          <section className={workspaceClassName}>
            <nav className="detachedEditorActivityRail" aria-label="编辑器面板">
              <button
                type="button"
                className={sidebarVisible ? "active" : ""}
                aria-pressed={sidebarVisible}
                title={sidebarVisible ? "隐藏文件面板" : "显示文件面板"}
                onClick={() => setSidebarVisible((visible) => !visible)}
              >
                <FolderOpenOutlined />
              </button>
              <button
                type="button"
                className={inspectorVisible ? "active" : ""}
                aria-pressed={inspectorVisible}
                title={inspectorVisible ? "隐藏文件详情" : "显示文件详情"}
                onClick={() => setInspectorVisible((visible) => !visible)}
              >
                <InfoCircleOutlined />
              </button>
              <span className="detachedEditorActivitySpacer" />
              <span className="detachedEditorActivityMark">H</span>
            </nav>

            {sidebarVisible && (
              <aside className="detachedEditorSidebar">
                <div className="detachedEditorPanelHeading">
                  <strong>远程工作区</strong>
                  <span>{tabs.length} 个文件</span>
                </div>
                <div className="detachedEditorSessionTabs" role="tablist" aria-label="已打开文件">
                  {tabs.map((tab) => {
                    const dirty = isTabDirty(tab);
                    const state = tab.disconnected ? "离线" : tab.saving ? "保存中" : dirty ? "未保存" : "正常";
                    return (
                      <div
                        key={tab.key}
                        className={`detachedEditorSessionCard ${tab.key === activeKey ? "active" : ""} ${tab.disconnected ? "disconnected" : ""}`}
                        style={{ "--editor-session-color": sessionColor(tab.sessionId) } as CSSProperties}
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={tab.key === activeKey}
                          className="detachedEditorSessionSelect"
                          title={tab.path}
                          onClick={() => setActiveKey(tab.key)}
                        >
                          <span className="detachedEditorSessionIcon"><CloudServerOutlined /></span>
                          <span className="detachedEditorSessionCopy">
                            <strong className={tab.disconnected ? "editorTabDisconnected" : undefined}>{getFileName(tab.path)}</strong>
                            <small title={`${tab.sessionName || "远程会话"} · ${tab.sessionHost || "未知 IP"}`}>
                              <span className="detachedEditorSessionName">{tab.sessionName || "远程会话"}</span>
                              <i>·</i>
                              <span className="detachedEditorSessionHost">{tab.sessionHost || "未知 IP"}</span>
                            </small>
                          </span>
                          <span className={`detachedEditorSessionState ${dirty ? "dirty" : ""}`}>{state}</span>
                        </button>
                        <button
                          type="button"
                          className="detachedEditorSessionClose"
                          aria-label={`关闭 ${getFileName(tab.path)}`}
                          title={`关闭 ${getFileName(tab.path)}`}
                          onClick={() => closeTab(tab.key)}
                        >
                          <CloseOutlined />
                        </button>
                      </div>
                    );
                  })}
                  {!ready && <div className="detachedEditorSessionPlaceholder">正在载入文件…</div>}
                  {ready && tabs.length === 0 && <div className="detachedEditorSessionPlaceholder">暂无打开文件</div>}
                </div>

                <div className="detachedEditorSidebarSection path">
                  <div className="detachedEditorSectionLabel">当前位置</div>
                  <div className="detachedEditorPathCard">
                    <FolderOpenOutlined />
                    <code>{activeMeta?.parentPath || "/"}</code>
                  </div>
                </div>
              </aside>
            )}

            <section className="detachedEditorMain">
              <div className="detachedEditorDocumentBar">
                {activeMeta ? (
                  <>
                    <span className="detachedEditorLanguageBadge">{activeMeta.language.short}</span>
                    <strong>{activeMeta.language.label}</strong>
                    <i />
                    <span>{activeMeta.lineEnding}</span>
                    <span title="远端读取时已验证编码">{activeMeta.encoding}</span>
                    <span className="detachedEditorDocumentSpacer" />
                    <span className={`detachedEditorDocumentState ${activeDirty ? "dirty" : ""}`}>
                      {activeTab?.saving ? "正在保存…" : activeDirty ? "尚未保存" : "已同步"}
                    </span>
                  </>
                ) : (
                  <span>等待文件</span>
                )}
              </div>

              <div className="detachedEditorContent">
                {!ready ? (
                  <div className="detachedEditorLoading"><Spin /><span>正在载入远程文件…</span></div>
                ) : activeTab ? (
                  tabs.map((tab) => (
                    <div key={tab.key} className="detachedEditorPane" hidden={tab.key !== activeKey}>
                      <CodeEditor
                        path={tab.path}
                        value={tab.content}
                        height="100%"
                        onChange={(value) => updateContent(tab.key, value)}
                        onFormatJson={(value) => updateContent(tab.key, value)}
                      />
                    </div>
                  ))
                ) : (
                  <div className="detachedEditorEmpty">
                    <FileTextOutlined />
                    <strong>没有打开的文件</strong>
                    <span>请从主窗口的远程文件管理器重新打开文件</span>
                  </div>
                )}
              </div>
            </section>

            {inspectorVisible && (
              <aside className="detachedEditorInspector">
                <div className="detachedEditorPanelHeading">
                  <strong>文件详情</strong>
                  <InfoCircleOutlined />
                </div>
                {activeTab && activeMeta ? (
                  <div className="detachedEditorInspectorBody">
                    <div className="detachedEditorFileSummary">
                      <span className="detachedEditorFileBadge">{activeMeta.language.short}</span>
                      <span>
                        <strong>{activeMeta.fileName}</strong>
                        <small>{activeMeta.language.label}</small>
                      </span>
                    </div>

                    <dl className="detachedEditorProperties">
                      <div><dt>大小</dt><dd>{activeMeta.size}</dd></div>
                      <div><dt>行数</dt><dd>{activeMeta.lines}</dd></div>
                      <div><dt>编码</dt><dd>{activeMeta.encoding}</dd></div>
                      <div><dt>换行符</dt><dd>{activeMeta.lineEnding}</dd></div>
                    </dl>

                    <div className="detachedEditorInspectorSection">
                      <span className="detachedEditorSectionLabel">远程路径</span>
                      <code className="detachedEditorRemotePath">{activeTab.path}</code>
                    </div>

                    <div className="detachedEditorInspectorSection">
                      <span className="detachedEditorSectionLabel">保存状态</span>
                      <div className={`detachedEditorSaveState ${activeTab.disconnected ? "disconnected" : activeDirty ? "dirty" : "saved"}`}>
                        {activeTab.disconnected ? <DisconnectOutlined /> : <CheckCircleFilled />}
                        <span>
                          <strong>{activeTab.disconnected ? "远程连接已断开" : activeTab.saving ? "正在写入远端" : activeDirty ? "存在本地修改" : "内容已与远端同步"}</strong>
                          <small>{activeTab.disconnected ? "重新连接后才能保存" : activeDirty ? "按 Ctrl + S 保存" : "当前没有待保存内容"}</small>
                        </span>
                      </div>
                    </div>

                    <div className="detachedEditorInspectorSection">
                      <span className="detachedEditorSectionLabel">快捷操作</span>
                      <div className="detachedEditorShortcuts">
                        <span><kbd>Ctrl</kbd><kbd>S</kbd><em>保存到远端</em></span>
                        <span><kbd>Ctrl</kbd><kbd>F</kbd><em>查找内容</em></span>
                        <span><kbd>Ctrl</kbd><kbd>Z</kbd><em>撤销修改</em></span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="detachedEditorInspectorEmpty">载入文件后显示详情</div>
                )}
              </aside>
            )}
          </section>

          <footer className="detachedEditorStatusbar">
            <span className={`detachedEditorFooterConnection ${activeTab?.disconnected ? "disconnected" : ""}`}>
              <i />{activeTab?.disconnected ? "远程会话已断开" : activeTab ? "远程会话正常" : "等待远程会话"}
            </span>
            <span>{activeTab?.sessionName || "HelM Editor"}</span>
            <span className="detachedEditorStatusSpacer" />
            {activeMeta && <>
              <span>{activeMeta.language.label}</span>
              <span>{activeMeta.size}</span>
              <span>{activeMeta.lines} 行</span>
              <span className={activeDirty ? "dirty" : ""}>{activeDirty ? "未保存" : "已同步"}</span>
            </>}
          </footer>
        </main>
        <Modal
          open={Boolean(closePromptTab)}
          title={(
            <span className="detachedEditorCloseTitle">
              <span className="detachedEditorCloseTitleIcon"><ExclamationCircleFilled /></span>
              <span className="detachedEditorCloseTitleCopy">
                <strong>关闭未保存文件</strong>
                <small>关闭前请选择如何处理当前修改</small>
              </span>
            </span>
          )}
          centered
          width={520}
          className="detachedEditorCloseModal"
          onCancel={cancelClosePrompt}
          footer={closePromptTab ? (
            <div className="detachedEditorCloseActions">
              <Button onClick={cancelClosePrompt}>取消</Button>
              <span className="detachedEditorCloseActionGroup">
                <Button
                  danger
                  icon={<CloseCircleOutlined />}
                  disabled={closePromptTab.saving}
                  onClick={() => removeTab(closePromptTab.key)}
                >
                  不保存直接关闭
                </Button>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={closePromptSaving}
                  disabled={closePromptTab.disconnected}
                  onClick={() => saveTab(closePromptTab.key, true)}
                >
                  {closePromptTab.saving && !closePromptSaving ? "保存完成后关闭" : "保存并关闭"}
                </Button>
              </span>
            </div>
          ) : null}
        >
          {closePromptTab && (
            <div className="detachedEditorClosePrompt">
              <div className="detachedEditorCloseFileCard">
                <span className="detachedEditorCloseFileIcon"><FileTextOutlined /></span>
                <span className="detachedEditorCloseFileCopy">
                  <small>未保存文件</small>
                  <strong title={closePromptTab.path}>{getFileName(closePromptTab.path)}</strong>
                  <code title={closePromptTab.path}>{closePromptTab.path}</code>
                </span>
                <span className="detachedEditorCloseBadge">未保存</span>
              </div>
              <div className="detachedEditorCloseHint">
                <InfoCircleOutlined />
                <span>保存会先将内容写入远端，确认成功后再关闭；直接关闭将放弃本次修改。</span>
              </div>
              {closePromptTab.disconnected && (
                <div className="detachedEditorCloseWarning">远程连接已断开，当前无法保存，只能取消或不保存直接关闭。</div>
              )}
            </div>
          )}
        </Modal>
        <Modal
          open={windowClosePromptOpen}
          title={(
            <span className="detachedEditorCloseTitle">
              <span className="detachedEditorCloseTitleIcon danger"><ExclamationCircleFilled /></span>
              <span className="detachedEditorCloseTitleCopy">
                <strong>关闭编辑器窗口</strong>
                <small>窗口中仍有尚未保存的远程文件</small>
              </span>
            </span>
          )}
          centered
          width={500}
          closable={!windowClosing}
          keyboard={!windowClosing}
          maskClosable={false}
          className="detachedEditorCloseModal detachedEditorWindowCloseModal"
          onCancel={() => {
            if (!windowClosing) setWindowClosePromptOpen(false);
          }}
          footer={(
            <div className="detachedEditorCloseActions window">
              <Button disabled={windowClosing} onClick={() => setWindowClosePromptOpen(false)}>取消</Button>
              <Button
                danger
                type="primary"
                icon={<CloseCircleOutlined />}
                loading={windowClosing}
                onClick={() => void forceCloseWindow()}
              >
                不保存并关闭窗口
              </Button>
            </div>
          )}
        >
          <div className="detachedEditorClosePrompt">
            <div className="detachedEditorWindowCloseSummary">
              <strong>{dirtyTabs.length} 个文件尚未保存</strong>
              <span>直接关闭窗口后，这些本地修改将无法恢复。</span>
            </div>
            <div className="detachedEditorDirtyFileList">
              {dirtyTabs.slice(0, 4).map((tab) => (
                <div key={tab.key}>
                  <FileTextOutlined />
                  <span title={tab.path}>{getFileName(tab.path)}</span>
                  <small>{tab.disconnected ? "连接已断开" : "未保存"}</small>
                </div>
              ))}
              {dirtyTabs.length > 4 && <p>另外还有 {dirtyTabs.length - 4} 个未保存文件</p>}
            </div>
          </div>
        </Modal>
      </AntdApp>
    </ConfigProvider>
  );
}
