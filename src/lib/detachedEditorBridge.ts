import { EDITOR_CHANNEL_NAME, type EditorChannelMessage } from "./editorChannel";
import { getErrorMessage } from "./configMapping";
type DetachedEditorTabPayload = { path: string; content: string; sessionId: string; sessionName: string; sessionHost: string };

export function postEditorMessage(channel: BroadcastChannel, message: EditorChannelMessage): boolean {
  try {
    channel.postMessage(message);
    return true;
  } catch (error) {
    console.warn("[helm] failed to post editor message:", getErrorMessage(error));
    return false;
  }
}

type EditorWriteText = (path: string, content: string, sessionId?: string) => Promise<void>;

let sharedDetachedEditorChannel: BroadcastChannel | null = null;
let sharedDetachedEditorWindow: Window | null = null;
let sharedEditorWriteText: EditorWriteText | null = null;
let sharedDetachedEditorReady = false;
const pendingDetachedEditorTabs = new Map<string, DetachedEditorTabPayload>();

function detachedEditorTabKey(tab: DetachedEditorTabPayload) {
  return `${tab.sessionId}\u0000${tab.path}`;
}

function flushPendingDetachedEditorTabs(channel: BroadcastChannel) {
  const tabs = Array.from(pendingDetachedEditorTabs.values());
  if (tabs.length === 0) return;
  tabs.forEach((tab, index) => {
    const sent = postEditorMessage(channel, { type: index === 0 ? "init" : "addTab", ...tab });
    if (sent) pendingDetachedEditorTabs.delete(detachedEditorTabKey(tab));
  });
}

export function queueDetachedEditorTab(channel: BroadcastChannel, tab: DetachedEditorTabPayload) {
  if (sharedDetachedEditorReady && postEditorMessage(channel, { type: "addTab", ...tab })) return;
  pendingDetachedEditorTabs.set(detachedEditorTabKey(tab), tab);
}

export function closeDetachedEditorChannel(channel?: BroadcastChannel) {
  if (channel && sharedDetachedEditorChannel !== channel) return;
  const target = channel ?? sharedDetachedEditorChannel;
  if (!target) return;
  target.close();
  if (sharedDetachedEditorChannel === target) sharedDetachedEditorChannel = null;
  sharedDetachedEditorWindow = null;
  sharedEditorWriteText = null;
  sharedDetachedEditorReady = false;
  pendingDetachedEditorTabs.clear();
}

export function closeSharedDetachedEditorChannel() {
  closeDetachedEditorChannel();
}

export function createDetachedEditorChannel(initialTab: DetachedEditorTabPayload, writeText: EditorWriteText) {
  const channel = new BroadcastChannel(EDITOR_CHANNEL_NAME);
  sharedDetachedEditorChannel = channel;
  sharedEditorWriteText = writeText;
  sharedDetachedEditorReady = false;
  pendingDetachedEditorTabs.set(detachedEditorTabKey(initialTab), initialTab);
  channel.onmessage = (event: MessageEvent<EditorChannelMessage>) => {
    const payload = event.data;
    if (payload.type === "ready") {
      sharedDetachedEditorReady = true;
      flushPendingDetachedEditorTabs(channel);
    }
    if (payload.type === "save") {
      const save = sharedEditorWriteText;
      if (!save) {
        postEditorMessage(channel, {
          type: "error",
          message: "主窗口暂时无法处理文件保存",
          path: payload.path,
          sessionId: payload.sessionId,
          saveId: payload.saveId,
        });
        return;
      }
      void save(payload.path, payload.content, payload.sessionId)
        .then(() => {
          if (sharedDetachedEditorChannel === channel) {
            postEditorMessage(channel, { type: "saved", path: payload.path, sessionId: payload.sessionId, saveId: payload.saveId, content: payload.content });
          }
        })
        .catch((error) => {
          if (sharedDetachedEditorChannel === channel) {
            postEditorMessage(channel, { type: "error", message: getErrorMessage(error), path: payload.path, sessionId: payload.sessionId, saveId: payload.saveId });
          }
        });
    }
    if (payload.type === "close") {
      closeDetachedEditorChannel(channel);
    }
  };
  return channel;
}

export function getOrCreateDetachedEditorChannel(initialTab: DetachedEditorTabPayload, writeText: EditorWriteText) {
  sharedEditorWriteText = writeText;
  return sharedDetachedEditorChannel ?? createDetachedEditorChannel(initialTab, writeText);
}

export function getDetachedEditorWindow() { return sharedDetachedEditorWindow; }
export function setDetachedEditorWindow(window: Window) { sharedDetachedEditorWindow = window; }
