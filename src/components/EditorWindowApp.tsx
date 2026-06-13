import { App as AntdApp, Button, ConfigProvider, Spin, Tabs, message, theme } from "antd";
import { SaveOutlined } from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useRef, useState } from "react";
import { CodeEditor } from "./CodeEditor";
import { editorChannelName, type EditorChannelMessage } from "../lib/editorChannel";

interface EditorTab {
  path: string;
  content: string;
  originalContent: string;
  saving: boolean;
  sessionId: string;
  sessionName: string;
  disconnected?: boolean;
}

function getFileName(path: string) {
  return path.split(/[/\\]/).pop() || path;
}

export function EditorWindowApp() {
  const editorId = new URLSearchParams(window.location.search).get("editorWindow") ?? "";
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [ready, setReady] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (!editorId) return;
    const channel = new BroadcastChannel(editorChannelName(editorId));
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<EditorChannelMessage>) => {
      const payload = event.data;
      if (payload.type === "init") {
        setTabs([{ path: payload.path, content: payload.content, originalContent: payload.content, saving: false, sessionId: payload.sessionId ?? "", sessionName: payload.sessionName ?? "" }]);
        setActiveKey(payload.path);
        setReady(true);
      }
      if (payload.type === "addTab") {
        setTabs((prev) => {
          if (prev.some((t) => t.path === payload.path && t.sessionId === payload.sessionId)) return prev;
          return [...prev, { path: payload.path, content: payload.content, originalContent: payload.content, saving: false, sessionId: payload.sessionId ?? "", sessionName: payload.sessionName ?? "" }];
        });
        setActiveKey(payload.path);
      }
      if (payload.type === "saved") {
        setTabs((prev) => prev.map((t) => (t.path === payload.path && t.sessionId === (payload.sessionId ?? "")) ? { ...t, saving: false, originalContent: t.content } : t));
        message.open({ key: "editor-save", type: "success", content: "文件已保存", duration: 2 });
      }
      if (payload.type === "error") {
        setTabs((prev) => prev.map((t) => (t.path === payload.path && t.sessionId === (payload.sessionId ?? "")) ? { ...t, saving: false } : t));
        message.error(payload.message);
      }
      if (payload.type === "sessionDisconnected") {
        setTabs((prev) => prev.map((t) => t.sessionId === payload.sessionId ? { ...t, disconnected: true, saving: false } : t));
      }
      if (payload.type === "sessionReconnected") {
        setTabs((prev) => prev.map((t) => t.sessionId === payload.sessionId ? { ...t, disconnected: false } : t));
      }
    };
    channel.postMessage({ type: "ready" } satisfies EditorChannelMessage);
    const close = () => {
      try {
        channel.postMessage({ type: "close" } satisfies EditorChannelMessage);
      } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", close);
    return () => {
      window.removeEventListener("beforeunload", close);
      if (channelRef.current === channel) channelRef.current = null;
      channel.close();
    };
  }, [editorId]);

  function updateContent(path: string, value: string) {
    setTabs((prev) => prev.map((t) => t.path === path ? { ...t, content: value } : t));
  }

  function save() {
    const tab = tabs.find((t) => t.path === activeKey);
    if (!tab || tab.disconnected) return;
    setTabs((prev) => prev.map((t) => t.path === activeKey ? { ...t, saving: true } : t));
    channelRef.current?.postMessage({ type: "save", path: tab.path, content: tab.content, sessionId: tab.sessionId } satisfies EditorChannelMessage);
  }

  function closeTab(targetPath: string) {
    const tab = tabs.find((t) => t.path === targetPath);
    if (tab && tab.content !== tab.originalContent) {
      if (!window.confirm(`"${getFileName(targetPath)}" 已修改但未保存，确定关闭？`)) return;
    }
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== targetPath);
      if (activeKey === targetPath) {
        const idx = prev.findIndex((t) => t.path === targetPath);
        setActiveKey(next[Math.min(idx, next.length - 1)]?.path ?? "");
      }
      return next;
    });
  }

  const activeTab = tabs.find((t) => t.path === activeKey);

  const sessionColor = (id?: string) => {
    if (!id) return "#4f6ef7";
    const colors = ["#4f6ef7", "#13c2c2", "#52c41a", "#fa8c16", "#722ed1", "#eb2f96"];
    let h = 0;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    return colors[Math.abs(h) % colors.length];
  };

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm }}>
      <AntdApp>
        <main className="detachedEditorWindow">
          <header className="detachedEditorHeader">
            <div>
              <div className="editorHeaderMeta">
                {activeTab?.sessionName && (
                  <span className="editorHeaderSession" style={{ background: `${sessionColor(activeTab.sessionId)}18`, color: sessionColor(activeTab.sessionId), borderColor: sessionColor(activeTab.sessionId) }}>
                    {activeTab.sessionName}
                  </span>
                )}
              </div>
              <strong className="editorHeaderPath">{activeTab?.path || "文件编辑器"}</strong>
              {activeTab?.disconnected && <span className="editorHeaderWarning">连接已断开，无法保存</span>}
            </div>
            <Button
              type="primary"
              className="editorPrimarySaveButton"
              aria-label="保存文件"
              icon={<SaveOutlined />}
              loading={activeTab?.saving}
              disabled={!ready || !activeTab || activeTab.disconnected}
              onClick={save}
            >
              保存文件
            </Button>
          </header>
          {ready ? (
            <div className="detachedEditorBody">
              {tabs.length > 1 && (
                <Tabs
                  type="editable-card"
                  hideAdd
                  activeKey={activeKey}
                  onChange={setActiveKey}
                  onEdit={(targetKey, action) => { if (action === "remove") closeTab(targetKey as string); }}
                  className="detachedEditorTabs"
                  items={tabs.map((t) => ({
                    key: t.path,
                    label: (
                      <span className={t.disconnected ? "editorTabDisconnected" : undefined}>
                        {getFileName(t.path)}
                      </span>
                    ),
                  }))}
                />
              )}
              <div className="detachedEditorContent">
                {tabs.map((t) => (
                  <div key={t.path} style={{ display: t.path === activeKey ? "flex" : "none", flexDirection: "column", height: "100%" }}>
                    <CodeEditor
                      path={t.path}
                      value={t.content}
                      height="100%"
                      onChange={(v) => updateContent(t.path, v)}
                      onFormatJson={(v) => updateContent(t.path, v)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="detachedEditorLoading">
              <Spin />
            </div>
          )}
        </main>
      </AntdApp>
    </ConfigProvider>
  );
}
