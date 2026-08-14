import {
  ArrowUpOutlined,
  CodeOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  TagOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { App as AntdApp, Button, Dropdown, Form, Input, Modal, Table, Tooltip } from "antd";
import type { MenuProps } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type SetStateAction,
} from "react";
import { writeClipboardText } from "../lib/clipboard";
import { formatFileSize } from "../lib/format";
import { getErrorMessage } from "../lib/configMapping";
import { readJsonStorage, writeJsonStorage } from "../lib/storage";
import { EDITOR_CHANNEL_NAME, type EditorChannelMessage } from "../lib/editorChannel";
import { getBaseName, getParentPath, joinPath, normalizePath } from "../lib/path";
import { isTauriRuntime } from "../api/runtime";
import { useMountedRef } from "../lib/reactLifecycle";
import { onSftpDirectoryInvalidation } from "../lib/sftpDirectoryEvents";
import { createLatestRequestTracker } from "../lib/keyedInFlight";
import { sortRemoteEntries, compareEntryGroup, compareEntryName, formatBeijingModifiedTime } from "../lib/fileClassify";
import { fileCategoryMeta } from "./fileManager/fileIcons";
import { QuickCommandDock, QuickCommandTopArea } from "./fileManager/QuickCommandPanel";
import { FileDialogs, operationLabel, type FileDialogState } from "./fileManager/FileDialogs";
import { DirectoryTree, buildTreeData } from "./fileManager/DirectoryTree";
import { contextMenuPositionInContainer } from "./fileManager/contextMenuPosition";
import type { RemoteDownloadSelection } from "../app/remoteDownloadPlan";
import {
  expandDirectoryParentsForPathChange,
  loadDirectoryViewState,
  sameDirectorySession,
  saveDirectoryViewState,
  uniqueKeys,
} from "./fileManager/directoryViewState";
import type { QuickCommand, RemoteFileEntry, RemoteSession } from "../types";

interface FileManagerProps {
  session: RemoteSession;
  active: boolean;
  onPathChange: (path: string) => void;
  onRefresh: () => Promise<void>;
  onRemoteSearch: (query: string, signal?: AbortSignal) => Promise<string | null>;
  onListDirectory: (path: string, force?: boolean) => Promise<RemoteFileEntry[]>;
  onFileOperation: (operation: FileOperation) => Promise<string[]>;
  onUploadFiles: (localPaths: string[], targetDirectory: string) => Promise<void>;
  onDownloadFiles: (files: RemoteDownloadSelection[]) => Promise<void>;
  onReadText: (path: string, sessionId?: string) => Promise<string>;
  onWriteText: (path: string, content: string, sessionId?: string) => Promise<void>;
  onSendCommand: (command: string) => Promise<void>;
  quickCommands: QuickCommand[];
  onQuickCommandUpsert: (command: QuickCommand) => Promise<void>;
  onQuickCommandDelete: (commandId: string) => Promise<void>;
  filesLoading?: boolean;
}

export type FileOperation =
  | { kind: "create"; entryType: "file" | "directory"; path: string }
  | { kind: "rename"; sourcePath: string; targetPath: string }
  | { kind: "copy"; sourcePath: string; targetPath: string }
  | { kind: "move"; sourcePath: string; targetPath: string }
  | { kind: "delete"; sourcePath: string }
  | { kind: "deleteMany"; sourcePaths: string[] };

type ContextMenuState = { entry: RemoteFileEntry; x: number; y: number };
type DetachedEditorTabPayload = { path: string; content: string; sessionId: string; sessionName: string; sessionHost: string };

const DETACHED_EDITOR_WINDOW_LABEL = "editor-global";

const baseColumns: ColumnsType<RemoteFileEntry> = [
  {
    title: "文件名",
    key: "name",
    dataIndex: "name",
    sorter: (a, b) => compareEntryGroup(a, b) || compareEntryName(a, b),
    render: (name: string, entry) => {
      const meta = fileCategoryMeta(entry);
      return (
        <span className={`fileName fileName-${meta.category}`} title={entry.path || name}>
          {meta.icon}
          {name}
        </span>
      );
    },
  },
  {
    title: "大小",
    key: "size",
    sorter: (a, b) => compareEntryGroup(a, b) || a.size - b.size || compareEntryName(a, b),
    render: (_, entry) => <span title={formatFileSize(entry)}>{formatFileSize(entry)}</span>,
  },
  {
    title: "类型",
    key: "type",
    render: (_, entry) => {
      const meta = fileCategoryMeta(entry);
      return <span className={`fileTypeBadge fileTypeBadge-${meta.category}`} title={meta.description}>{meta.label}</span>;
    },
  },
  {
    title: "修改时间",
    key: "modifiedAt",
    dataIndex: "modifiedAt",
    sorter: (a, b) => compareEntryGroup(a, b) || a.modifiedAt.localeCompare(b.modifiedAt) || compareEntryName(a, b),
    render: (value: string) => {
      const formatted = formatBeijingModifiedTime(value);
      return <span title={formatted === value ? value : `${formatted}（北京时间）`}>{formatted}</span>;
    },
  },
  { title: "权限", key: "permissions", dataIndex: "permissions", render: (value: string) => <span title={value}>{value}</span> },
  { title: "用户/组", key: "owner", dataIndex: "owner", render: (value: string) => <span title={value}>{value || "-"}</span> },
];

const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  name: 260,
  size: 88,
  type: 98,
  modifiedAt: 190,
  permissions: 112,
  owner: 96,
};
const MIN_COLUMN_WIDTH = 64;
const TYPE_COLUMN_MIN_WIDTH = 98;
const TYPE_COLUMN_MAX_WIDTH = 150;
const TYPE_COLUMN_LABEL_MIN_CHARS = 5;
const TYPE_COLUMN_CELL_CHROME = 34;

const COLUMN_WIDTHS_KEY = "helm:fileColumnWidths";
const QUICK_COMMAND_DOCK_WIDTH_KEY = "helm:quickCommandDockWidth";
const QUICK_COMMAND_DOCK_DEFAULT_WIDTH = 340;
const QUICK_COMMAND_DOCK_MIN_WIDTH = 286;
const QUICK_COMMAND_DOCK_MAX_WIDTH = 440;

function normalizeQuickCommandDockWidth(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return QUICK_COMMAND_DOCK_DEFAULT_WIDTH;
  return Math.min(QUICK_COMMAND_DOCK_MAX_WIDTH, Math.max(QUICK_COMMAND_DOCK_MIN_WIDTH, Math.round(value)));
}

function loadQuickCommandDockWidth() {
  return readJsonStorage<number>(QUICK_COMMAND_DOCK_WIDTH_KEY, QUICK_COMMAND_DOCK_DEFAULT_WIDTH, normalizeQuickCommandDockWidth);
}

function loadColumnWidths(): Record<string, number> {
  return readJsonStorage<Record<string, number>>(COLUMN_WIDTHS_KEY, { ...DEFAULT_COLUMN_WIDTHS }, normalizeColumnWidths);
}

function normalizeColumnWidths(value: unknown): Record<string, number> {
  const widths = { ...DEFAULT_COLUMN_WIDTHS };
  if (!value || typeof value !== "object") return widths;
  for (const [key, rawWidth] of Object.entries(value)) {
    if (!(key in DEFAULT_COLUMN_WIDTHS) || typeof rawWidth !== "number" || !Number.isFinite(rawWidth)) continue;
    widths[key] = Math.max(columnMinWidth(key), rawWidth);
  }
  return widths;
}

function columnMinWidth(key: string) {
  return key === "type" ? TYPE_COLUMN_MIN_WIDTH : MIN_COLUMN_WIDTH;
}

function typeLabelTextWidth(label: string) {
  return Array.from(label).reduce((sum, char) => sum + (char.charCodeAt(0) <= 0x7f ? 7 : 13), 0);
}

function autoTypeColumnWidth(entries: RemoteFileEntry[]) {
  const minLabelWidth = TYPE_COLUMN_LABEL_MIN_CHARS * 13;
  const labelWidth = entries.reduce((max, entry) => Math.max(max, typeLabelTextWidth(fileCategoryMeta(entry).label)), minLabelWidth);
  return Math.min(TYPE_COLUMN_MAX_WIDTH, Math.max(TYPE_COLUMN_MIN_WIDTH, Math.ceil(labelWidth + TYPE_COLUMN_CELL_CHROME)));
}

let inMemoryColumnWidths: Record<string, number> = loadColumnWidths();

interface ResizableHeaderCellProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  columnKey?: string;
  onStartResize?: (key: string, startX: number) => void;
}

function ResizableHeaderCell({ columnKey, onStartResize, children, ...rest }: ResizableHeaderCellProps) {
  return (
    <th {...rest}>
      {children}
      {columnKey && onStartResize ? (
        <span
          className="columnResizer"
          aria-hidden="true"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onStartResize(columnKey, event.clientX);
          }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
    </th>
  );
}

function droppedFilePaths(files: FileList): string[] {
  return Array.from(files).flatMap((file) => {
    const path = "path" in file && typeof file.path === "string" ? file.path : "";
    return path ? [path] : [];
  });
}

const tableComponents = { header: { cell: ResizableHeaderCell } };

function fileColumnKey(column: ColumnsType<RemoteFileEntry>[number]): string | null {
  return typeof column.key === "string" ? column.key : null;
}

function isStringKey(key: React.Key): key is string {
  return typeof key === "string";
}

function postEditorMessage(channel: BroadcastChannel, message: EditorChannelMessage): boolean {
  try {
    channel.postMessage(message);
    return true;
  } catch (error) {
    console.warn("[helm] failed to post editor message:", getErrorMessage(error));
    return false;
  }
}

function editorSessionHost(session: RemoteSession) {
  return [session.telemetry.ip, session.telemetry.ipv6, session.host]
    .map((value) => value.trim())
    .find((value) => value && value !== "-" && value !== "未知") ?? "";
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

function queueDetachedEditorTab(channel: BroadcastChannel, tab: DetachedEditorTabPayload) {
  if (sharedDetachedEditorReady && postEditorMessage(channel, { type: "addTab", ...tab })) return;
  pendingDetachedEditorTabs.set(detachedEditorTabKey(tab), tab);
}

function closeDetachedEditorChannel(channel?: BroadcastChannel) {
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

function createDetachedEditorChannel(initialTab: DetachedEditorTabPayload, writeText: EditorWriteText) {
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

function getOrCreateDetachedEditorChannel(initialTab: DetachedEditorTabPayload, writeText: EditorWriteText) {
  sharedEditorWriteText = writeText;
  return sharedDetachedEditorChannel ?? createDetachedEditorChannel(initialTab, writeText);
}

function FileManagerView({
  session,
  active,
  onPathChange,
  onRefresh,
  onRemoteSearch,
  onListDirectory,
  onFileOperation,
  onUploadFiles,
  onDownloadFiles,
  onReadText,
  onWriteText,
  onSendCommand,
  quickCommands,
  onQuickCommandUpsert,
  onQuickCommandDelete,
  filesLoading = false,
}: FileManagerProps) {
  const { message, modal } = AntdApp.useApp();
  const quickCommandDockId = `quick-command-dock-${useId().replace(/:/g, "")}`;
  const sessionEditorName = session.name || session.host;
  const sessionEditorHost = editorSessionHost(session);
  const [searchText, setSearchText] = useState("");
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [tableScrollY, setTableScrollY] = useState(180);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<FileDialogState | null>(null);
  const [directoryEntries, setDirectoryEntries] = useState<Record<string, RemoteFileEntry[]>>(
    () => loadDirectoryViewState(session).entries,
  );
  const [directoryLoadingKeys, setDirectoryLoadingKeys] = useState<string[]>([]);
  const [directoryExpandedKeys, setDirectoryExpandedKeys] = useState<string[]>(
    () => loadDirectoryViewState(session).expandedKeys,
  );
  const [dragging, setDragging] = useState(false);
  const openingEditorRequestRef = useRef<string | null>(null);
  const refreshRequestRef = useRef<string | null>(null);
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [commandEditingId, setCommandEditingId] = useState<string | null>(null);
  const [commandName, setCommandName] = useState("");
  const [commandValue, setCommandValue] = useState("");
  const [commandSaving, setCommandSaving] = useState(false);
  const commandDialogRequestRef = useRef(0);
  const [quickCommandsOpen, setQuickCommandsOpen] = useState(false);
  const [quickCommandDockWidth, setQuickCommandDockWidth] = useState(loadQuickCommandDockWidth);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => ({ ...inMemoryColumnWidths }));
  const [tableSurfaceWidth, setTableSurfaceWidth] = useState(0);
  const columnWidthsRef = useRef(columnWidths);
  const effectiveColumnWidthsRef = useRef(columnWidths);
  const mountedRef = useMountedRef();
  const sessionIdRef = useRef(session.id);
  const sessionConnectionIdRef = useRef(session.connectionId ?? null);
  const sessionTerminalIdRef = useRef(session.terminalId ?? null);
  const activeRef = useRef(active);
  const directoryRequestTrackerRef = useRef(createLatestRequestTracker<string>());
  const directoryStateSessionIdRef = useRef(session.id);
  const directoryStateSftpIdRef = useRef(session.sftpId ?? null);
  const directoryEntriesRef = useRef(directoryEntries);
  const directoryExpandedKeysRef = useRef(directoryExpandedKeys);
  const directoryPathRef = useRef(normalizePath(session.currentPath));
  const pathRef = useRef(normalizePath(session.currentPath));
  sessionIdRef.current = session.id;
  sessionConnectionIdRef.current = session.connectionId ?? null;
  sessionTerminalIdRef.current = session.terminalId ?? null;
  activeRef.current = active;
  pathRef.current = normalizePath(session.currentPath);

  function invalidateOpeningEditorRequest() {
    const requestId = openingEditorRequestRef.current;
    openingEditorRequestRef.current = null;
    if (requestId) message.destroy(`editor-open-${requestId}`);
  }

  function invalidateRefreshRequest() {
    refreshRequestRef.current = null;
    setRefreshing(false);
  }
  useEffect(() => {
    const channel = new BroadcastChannel(EDITOR_CHANNEL_NAME);
    const publishMetadata = () => postEditorMessage(channel, {
      type: "sessionMetadata",
      sessionId: session.id,
      sessionName: sessionEditorName,
      sessionHost: sessionEditorHost,
    });
    channel.onmessage = (event: MessageEvent<EditorChannelMessage>) => {
      const payload = event.data;
      if (payload.type === "requestSessionMetadata" && payload.sessionIds.includes(session.id)) {
        publishMetadata();
      }
    };
    publishMetadata();
    return () => channel.close();
  }, [session.id, sessionEditorHost, sessionEditorName]);
  useEffect(() => {
    columnWidthsRef.current = columnWidths;
    inMemoryColumnWidths = columnWidths;
    writeJsonStorage(COLUMN_WIDTHS_KEY, columnWidths);
  }, [columnWidths]);
  useEffect(() => {
    writeJsonStorage(QUICK_COMMAND_DOCK_WIDTH_KEY, quickCommandDockWidth);
  }, [quickCommandDockWidth]);
  const contentRef = useRef<HTMLDivElement>(null);
  const tableSurfaceRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);
  const columnResizeCleanupRef = useRef<(() => void) | null>(null);
  const quickCommandDockResizeCleanupRef = useRef<(() => void) | null>(null);

  function persistDirectoryViewState(
    entries = directoryEntriesRef.current,
    expandedKeys = directoryExpandedKeysRef.current,
  ) {
    saveDirectoryViewState(
      directoryStateSessionIdRef.current,
      directoryStateSftpIdRef.current,
      directoryPathRef.current,
      entries,
      expandedKeys,
    );
  }

  function updateDirectoryEntries(action: SetStateAction<Record<string, RemoteFileEntry[]>>) {
    const next = resolveStateAction(action, directoryEntriesRef.current);
    directoryEntriesRef.current = next;
    persistDirectoryViewState(next);
    setDirectoryEntries(next);
  }

  function updateDirectoryExpandedKeys(action: SetStateAction<string[]>) {
    const next = resolveStateAction(action, directoryExpandedKeysRef.current);
    directoryExpandedKeysRef.current = next;
    persistDirectoryViewState(directoryEntriesRef.current, next);
    setDirectoryExpandedKeys(next);
  }

  function directoryViewMatchesRender() {
    return directorySessionMatchesRender()
      && directoryEntriesRef.current === directoryEntries
      && directoryExpandedKeysRef.current === directoryExpandedKeys;
  }

  function directorySessionMatchesRender() {
    return sameDirectorySession(
      {
        sessionId: directoryStateSessionIdRef.current,
        sftpId: directoryStateSftpIdRef.current,
      },
      {
        sessionId: session.id,
        sftpId: session.sftpId ?? null,
      },
    );
  }

  useLayoutEffect(() => {
    const nextSftpId = session.sftpId ?? null;
    const sessionChanged = directoryStateSessionIdRef.current !== session.id;
    const sftpChanged = directoryStateSftpIdRef.current !== nextSftpId;
    if (!sessionChanged && !sftpChanged) return;

    persistDirectoryViewState();
    const nextDirectoryView = loadDirectoryViewState(session);
    directoryStateSessionIdRef.current = session.id;
    directoryStateSftpIdRef.current = nextSftpId;
    directoryEntriesRef.current = nextDirectoryView.entries;
    directoryExpandedKeysRef.current = nextDirectoryView.expandedKeys;
    directoryPathRef.current = normalizePath(session.currentPath);
    setDirectoryEntries(nextDirectoryView.entries);
    setDirectoryExpandedKeys(nextDirectoryView.expandedKeys);
    setDirectoryLoadingKeys([]);
    directoryRequestTrackerRef.current.clear();

    searchSeq.current += 1;
    setSearching(false);
    invalidateOpeningEditorRequest();
    invalidateRefreshRequest();
    setSearchText("");
    setFocusedPath(null);
    setSelectedRowKeys([]);
    setContextMenu(null);
    setDialog(null);
    setDragging(false);
    if (!sessionChanged) return;
    setCommandDialogOpen(false);
    setCommandEditingId(null);
    setCommandSaving(false);
    commandDialogRequestRef.current += 1;
  }, [session.id, session.sftpId]);

  const path = normalizePath(session.currentPath);
  const canUseFiles = session.state === "connected" && Boolean(session.sftpId);
  const canRefreshFiles = canUseFiles || (session.state === "connected" && Boolean(session.connectionId));
  const allFiles = useMemo(() => sortRemoteEntries(session.files), [session.files]);
  const lowerSearchText = searchText.toLowerCase();
  const files = useMemo(
    () => (lowerSearchText ? allFiles.filter((f) => f.name.toLowerCase().includes(lowerSearchText)) : allFiles),
    [allFiles, lowerSearchText],
  );
  const effectiveColumnWidths = useMemo<Record<string, number>>(
    () => ({
      ...columnWidths,
      type: Math.max(columnWidths.type ?? DEFAULT_COLUMN_WIDTHS.type, autoTypeColumnWidth(files)),
    }),
    [columnWidths, files],
  );
  useEffect(() => {
    effectiveColumnWidthsRef.current = effectiveColumnWidths;
  }, [effectiveColumnWidths]);
  const filesMatchCurrentPath = Boolean(
    session.filesPath && normalizePath(session.filesPath) === path,
  );
  const directoryChanging = canUseFiles && (filesLoading || !filesMatchCurrentPath);
  const tableLoading = searching || refreshing || directoryChanging;
  const treeData = useMemo(() => buildTreeData(directoryEntries, path, new Set(directoryLoadingKeys)), [directoryEntries, path, directoryLoadingKeys]);
  const commandItems = useMemo(
    () =>
      [...quickCommands]
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")),
    [quickCommands],
  );
  const quickCommandHiddenColumnKeys = useMemo(() => {
    const hidden = new Set<string>();
    if (!quickCommandsOpen || tableSurfaceWidth <= 0) return hidden;
    if (tableSurfaceWidth < 720) hidden.add("owner");
    if (tableSurfaceWidth < 620) hidden.add("permissions");
    if (tableSurfaceWidth < 520) hidden.add("type");
    return hidden;
  }, [quickCommandsOpen, tableSurfaceWidth]);

  const handleColumnResizeStart = useCallback((key: string, startX: number) => {
    columnResizeCleanupRef.current?.();
    const startWidth = effectiveColumnWidthsRef.current[key] ?? columnWidthsRef.current[key] ?? DEFAULT_COLUMN_WIDTHS[key] ?? 100;
    function onMove(event: MouseEvent) {
      const next = Math.max(columnMinWidth(key), Math.round(startWidth + event.clientX - startX));
      setColumnWidths((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }));
    }
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", cleanup);
      document.body.classList.remove("isResizingColumn");
      if (columnResizeCleanupRef.current === cleanup) columnResizeCleanupRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", cleanup);
    document.body.classList.add("isResizingColumn");
    columnResizeCleanupRef.current = cleanup;
  }, []);

  const quickCommandDockMaximumWidth = useCallback(() => {
    const contentWidth = contentRef.current?.getBoundingClientRect().width ?? 0;
    if (contentWidth <= 0) return QUICK_COMMAND_DOCK_MAX_WIDTH;
    return Math.max(
      QUICK_COMMAND_DOCK_MIN_WIDTH,
      Math.min(QUICK_COMMAND_DOCK_MAX_WIDTH, Math.floor(contentWidth * .38)),
    );
  }, []);

  const resizeQuickCommandDock = useCallback((width: number) => {
    const maximumWidth = quickCommandDockMaximumWidth();
    setQuickCommandDockWidth(Math.min(maximumWidth, Math.max(QUICK_COMMAND_DOCK_MIN_WIDTH, Math.round(width))));
  }, [quickCommandDockMaximumWidth]);

  const handleQuickCommandDockResizeStart = useCallback((startX: number) => {
    quickCommandDockResizeCleanupRef.current?.();
    const startWidth = quickCommandDockWidth;

    function onMove(event: MouseEvent) {
      resizeQuickCommandDock(startWidth + startX - event.clientX);
    }

    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", cleanup);
      document.body.classList.remove("isResizingQuickCommandDock");
      if (quickCommandDockResizeCleanupRef.current === cleanup) quickCommandDockResizeCleanupRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", cleanup);
    document.body.classList.add("isResizingQuickCommandDock");
    quickCommandDockResizeCleanupRef.current = cleanup;
  }, [quickCommandDockWidth, resizeQuickCommandDock]);

  const resizableColumns = useMemo<ColumnsType<RemoteFileEntry>>(
    () =>
      baseColumns.filter((column) => {
        const key = fileColumnKey(column);
        return !key || !quickCommandHiddenColumnKeys.has(key);
      }).map((column) => {
        const key = fileColumnKey(column);
        if (!key) return column;
        const headerCellProps: ResizableHeaderCellProps = {
          columnKey: key,
          onStartResize: handleColumnResizeStart,
        };
        const col = {
          ...column,
          width: effectiveColumnWidths[key] ?? DEFAULT_COLUMN_WIDTHS[key],
          onHeaderCell: () => headerCellProps,
        };
        if (key === "name") {
          const dirName = path === "/" ? "/" : getBaseName(path) || "/";
          col.title = (
            <span className="fileColumnNameHeader">
              文件名
              <span className="fileColumnPathHint">{dirName}</span>
            </span>
          );
        }
        return col;
      }),
    [effectiveColumnWidths, handleColumnResizeStart, path, quickCommandHiddenColumnKeys],
  );

  const tableColumnWidth = useMemo(
    () => 48 + Object.keys(DEFAULT_COLUMN_WIDTHS).reduce(
      (sum, key) => sum + (quickCommandHiddenColumnKeys.has(key) ? 0 : (effectiveColumnWidths[key] ?? DEFAULT_COLUMN_WIDTHS[key])),
      0,
    ),
    [effectiveColumnWidths, quickCommandHiddenColumnKeys],
  );
  const tableScrollX = useMemo(
    () => Math.max(tableColumnWidth, tableSurfaceWidth > 0 ? Math.ceil(tableSurfaceWidth) + 12 : 0),
    [tableColumnWidth, tableSurfaceWidth],
  );
  const selectedRowKeySet = useMemo(() => new Set(selectedRowKeys), [selectedRowKeys]);

  useEffect(() => {
    return () => {
      columnResizeCleanupRef.current?.();
      columnResizeCleanupRef.current = null;
      quickCommandDockResizeCleanupRef.current?.();
      quickCommandDockResizeCleanupRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const update = () => {
      setTableScrollY(Math.max(120, element.clientHeight - 30));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = tableSurfaceRef.current;
    if (!element) return;
    const update = () => {
      const next = Math.floor(element.clientWidth);
      setTableSurfaceWidth((current) => (current === next ? current : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!directoryViewMatchesRender()) return;
    if (!canUseFiles) {
      setSearching(false);
      setFocusedPath(null);
      setDirectoryLoadingKeys([]);
      return;
    }
    if (filesMatchCurrentPath) {
      updateDirectoryEntries((current) =>
        current[path] === allFiles ? current : { ...current, [path]: allFiles },
      );
    }
    const previousPath = directoryPathRef.current;
    directoryPathRef.current = path;
    if (normalizePath(previousPath) !== path) persistDirectoryViewState();
    const nextExpandedKeys = expandDirectoryParentsForPathChange(
      directoryExpandedKeysRef.current,
      previousPath,
      path,
    );
    if (nextExpandedKeys !== directoryExpandedKeysRef.current) {
      updateDirectoryExpandedKeys(nextExpandedKeys);
    }
    if (path !== "/" && !directoryEntries["/"]) void loadDirectory("/");
  }, [allFiles, canUseFiles, path, directoryEntries]);

  async function loadDirectory(directoryPath: string, force = false) {
    // 展开事件会先同步更新 expandedKeys 的 ref，再触发目录加载；此时 React
    // 还没提交新一轮渲染，完整的 view identity 必然暂时不一致。目录请求只需
    // 绑定当前会话/SFTP，结果落地时下方的请求身份检查仍会拦截真正的旧请求。
    if (!canUseFiles || !directorySessionMatchesRender()) return;
    const targetPath = normalizePath(directoryPath);
    if (!force && directoryEntriesRef.current[targetPath]) return;
    const requestSessionId = session.id;
    const requestSftpId = session.sftpId ?? null;
    const requestKey = `${requestSessionId}:${targetPath}`;
    const requestSeq = directoryRequestTrackerRef.current.begin(requestKey);
    setDirectoryLoadingKeys((current) => uniqueKeys([...current, targetPath]));
    try {
      const entries = !force && targetPath === path && filesMatchCurrentPath
        ? allFiles
        : await onListDirectory(targetPath, force);
      if (
        !mountedRef.current ||
        sessionIdRef.current !== requestSessionId ||
        directoryStateSessionIdRef.current !== requestSessionId ||
        directoryStateSftpIdRef.current !== requestSftpId ||
        !directoryRequestTrackerRef.current.isCurrent(requestKey, requestSeq)
      ) return;
      updateDirectoryEntries((current) => ({ ...current, [targetPath]: sortRemoteEntries(entries) }));
    } catch (error) {
      if (
        mountedRef.current &&
        sessionIdRef.current === requestSessionId &&
        directoryStateSessionIdRef.current === requestSessionId &&
        directoryStateSftpIdRef.current === requestSftpId &&
        directoryRequestTrackerRef.current.isCurrent(requestKey, requestSeq)
      ) {
        message.error(getErrorMessage(error));
      }
    } finally {
      if (
        mountedRef.current &&
        sessionIdRef.current === requestSessionId &&
        directoryStateSessionIdRef.current === requestSessionId &&
        directoryStateSftpIdRef.current === requestSftpId &&
        directoryRequestTrackerRef.current.complete(requestKey, requestSeq)
      ) {
        setDirectoryLoadingKeys((current) => current.filter((key) => key !== targetPath));
      }
    }
  }

  useEffect(() => {
    if (!active || !canUseFiles) {
      setSearching(false);
      if (active) setFocusedPath(null);
      return;
    }
    const query = searchText.trim();
    const seq = searchSeq.current + 1;
    searchSeq.current = seq;
    const controller = new AbortController();
    if (!query) {
      setSearching(false);
      setFocusedPath(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearching(true);
      void onRemoteSearch(query, controller.signal)
        .then((targetPath) => {
          if (!mountedRef.current || searchSeq.current !== seq) return;
          setFocusedPath(targetPath);
        })
        .catch((error) => {
          if (!mountedRef.current || searchSeq.current !== seq) return;
          console.warn("[helm] remote file search failed:", getErrorMessage(error));
          setFocusedPath(null);
        })
        .finally(() => {
          if (mountedRef.current && searchSeq.current === seq) setSearching(false);
        });
    }, 450);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [active, canUseFiles, path, searchText, session.id]);

  useEffect(() => {
    if (!active || !canUseFiles) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (disposed) return;
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragging(true);
          } else if (event.payload.type === "leave") {
            setDragging(false);
          } else if (event.payload.type === "drop") {
            setDragging(false);
            void uploadPaths(event.payload.paths);
          }
        }),
      )
      .then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch((error) => {
        console.warn("[helm] failed to register file drag listener:", getErrorMessage(error));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active, canUseFiles, path]);

  useEffect(() => {
    if (active) return;
    searchSeq.current += 1;
    setSearching(false);
    setContextMenu(null);
    setDialog(null);
    setDragging(false);
    invalidateOpeningEditorRequest();
    invalidateRefreshRequest();
    setCommandDialogOpen(false);
    setCommandEditingId(null);
    setCommandSaving(false);
    commandDialogRequestRef.current += 1;
  }, [active]);

  function openDirectory(entry: RemoteFileEntry) {
    if (!canUseFiles) return;
    if (entry.fileType !== "directory") {
      void openEditor(entry);
      return;
    }
    onPathChange(entry.path || joinPath(path, entry.name));
    setSearchText("");
    setFocusedPath(null);
    setSelectedRowKeys([]);
  }

  async function openEditor(entry: RemoteFileEntry) {
    if (!canUseFiles) return;
    const targetPath = entry.path || joinPath(path, entry.name);
    if (openingEditorRequestRef.current) return;

    const sessionId = session.id;
    const requestSftpId = session.sftpId;
    const sessionName = sessionEditorName;
    const sessionHost = sessionEditorHost;
    const requestId = crypto.randomUUID();

    openingEditorRequestRef.current = requestId;
    const messageKey = `editor-open-${requestId}`;
    let createdChannel: BroadcastChannel | null = null;
    message.open({ key: messageKey, type: "loading", content: "正在读取文件...", duration: 0 });
    try {
      const content = await onReadText(targetPath, sessionId);
      if (
        !mountedRef.current
        || openingEditorRequestRef.current !== requestId
        || sessionIdRef.current !== sessionId
        || directoryStateSftpIdRef.current !== requestSftpId
      ) return;

      const initialTab = { path: targetPath, content, sessionId, sessionName, sessionHost };

      if (isTauriRuntime()) {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        if (!mountedRef.current || openingEditorRequestRef.current !== requestId) return;
        const existingWindow = await WebviewWindow.getByLabel(DETACHED_EDITOR_WINDOW_LABEL);
        if (!mountedRef.current || openingEditorRequestRef.current !== requestId) return;
        if (existingWindow) {
          const channel = getOrCreateDetachedEditorChannel(initialTab, onWriteText);
          queueDetachedEditorTab(channel, initialTab);
          try {
            await existingWindow.setFocus();
          } catch (error) {
            console.warn("[helm] failed to focus editor window:", getErrorMessage(error));
          }
          if (mountedRef.current && openingEditorRequestRef.current === requestId) message.destroy(messageKey);
          return;
        }

        closeDetachedEditorChannel();
        const channel = createDetachedEditorChannel(initialTab, onWriteText);
        createdChannel = channel;
        const webview = new WebviewWindow(DETACHED_EDITOR_WINDOW_LABEL, {
          url: `index.html?editorWindow=${encodeURIComponent(EDITOR_CHANNEL_NAME)}`,
          title: "HelM Editor",
          width: 1280,
          height: 820,
          minWidth: 900,
          minHeight: 600,
          center: true,
          resizable: true,
          decorations: false,
          devtools: import.meta.env.DEV,
          maximizable: false,
          minimizable: true,
          closable: true,
          shadow: true,
          backgroundColor: "#f7f9fc",
        });
        await Promise.all([
          webview.once("tauri://error", (event) => {
            closeDetachedEditorChannel(channel);
            if (mountedRef.current && openingEditorRequestRef.current === requestId) {
              message.error(getErrorMessage(event.payload));
            }
          }),
          webview.once("tauri://destroyed", () => {
            closeDetachedEditorChannel(channel);
          }),
        ]);
      } else {
        const existingWindow = sharedDetachedEditorWindow;
        if (existingWindow?.closed) {
          closeDetachedEditorChannel();
        } else if (existingWindow) {
          const channel = getOrCreateDetachedEditorChannel(initialTab, onWriteText);
          queueDetachedEditorTab(channel, initialTab);
          try {
            existingWindow.focus();
          } catch (error) {
            console.warn("[helm] failed to focus editor window:", getErrorMessage(error));
          }
          if (mountedRef.current && openingEditorRequestRef.current === requestId) message.destroy(messageKey);
          return;
        }

        closeDetachedEditorChannel();
        const channel = createDetachedEditorChannel(initialTab, onWriteText);
        createdChannel = channel;
        const editorWindow = window.open(`${window.location.origin}${window.location.pathname}?editorWindow=${encodeURIComponent(EDITOR_CHANNEL_NAME)}`, DETACHED_EDITOR_WINDOW_LABEL, "width=1100,height=760");
        if (!editorWindow) {
          throw new Error("无法打开编辑器窗口，请检查弹窗拦截设置");
        }
        sharedDetachedEditorWindow = editorWindow;
      }
      if (mountedRef.current && openingEditorRequestRef.current === requestId) message.destroy(messageKey);
    } catch (error) {
      if (createdChannel && sharedDetachedEditorChannel === createdChannel) {
        closeDetachedEditorChannel(createdChannel);
      }
      if (mountedRef.current && openingEditorRequestRef.current === requestId) {
        message.open({ key: messageKey, type: "error", content: getErrorMessage(error), duration: 3 });
      }
    } finally {
      if (mountedRef.current && openingEditorRequestRef.current === requestId) {
        openingEditorRequestRef.current = null;
      }
    }
  }

  async function uploadPaths(localPaths: string[]) {
    if (!canUseFiles) return;
    if (localPaths.length === 0) return;
    const requestSessionId = session.id;
    const requestSftpId = session.sftpId ?? null;
    const targetDirectory = path;
    try {
      await onUploadFiles(localPaths, targetDirectory);
      if (
        mountedRef.current
        && sessionIdRef.current === requestSessionId
        && directoryStateSftpIdRef.current === requestSftpId
      ) {
        message.success(`已开始上传 ${localPaths.length} 个项目`);
      }
    } catch (error) {
      if (
        mountedRef.current
        && sessionIdRef.current === requestSessionId
        && directoryStateSftpIdRef.current === requestSftpId
      ) {
        message.error(getErrorMessage(error));
      }
    }
  }

  function goParent() {
    if (!canUseFiles) return;
    onPathChange(getParentPath(path));
    setSearchText("");
    setFocusedPath(null);
  }

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    setContextMenu(null);
  }, [session.id, path]);

  async function refresh() {
    if (!canRefreshFiles) return;
    if (refreshRequestRef.current) return;
    const requestId = crypto.randomUUID();
    const requestSessionId = session.id;
    const requestConnectionId = session.connectionId ?? null;
    const requestSftpId = session.sftpId ?? null;
    refreshRequestRef.current = requestId;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch (error) {
      if (
        mountedRef.current
        && refreshRequestRef.current === requestId
        && activeRef.current
        && sessionIdRef.current === requestSessionId
        && sessionConnectionIdRef.current === requestConnectionId
        && (requestSftpId === null || directoryStateSftpIdRef.current === requestSftpId)
      ) {
        message.error(`刷新失败：${getErrorMessage(error)}`);
      }
    } finally {
      if (mountedRef.current && refreshRequestRef.current === requestId) {
        refreshRequestRef.current = null;
        setRefreshing(false);
      }
    }
  }

  useEffect(() => onSftpDirectoryInvalidation((event) => {
    if (
      !mountedRef.current
      || !canUseFiles
      || directoryStateSftpIdRef.current !== event.sftpId
      || !directorySessionMatchesRender()
    ) return;
    const changedDirectories = event.directories.map(normalizePath);
    const changedDirectorySet = new Set(changedDirectories);
    for (const directory of changedDirectories) {
      // 先让已在途的旧目录请求失效；随后对展开目录发起的强制加载会取得
      // 新的全局版本号，因此旧响应无论何时到达都不能重新写入缓存。
      directoryRequestTrackerRef.current.invalidate(`${session.id}:${directory}`);
    }
    setDirectoryLoadingKeys((current) => current.filter((directory) => !changedDirectorySet.has(directory)));
    updateDirectoryEntries((current) => {
      let next = current;
      for (const directory of changedDirectories) {
        if (!(directory in next)) continue;
        if (next === current) next = { ...current };
        delete next[directory];
      }
      return next;
    });
    for (const directory of changedDirectories) {
      if (directory !== path && directoryExpandedKeysRef.current.includes(directory)) {
        void loadDirectory(directory, true);
      }
    }
  }), [canUseFiles, path, session.id, session.sftpId]);

  function startBackgroundOperation(operation: FileOperation) {
    const requestSessionId = session.id;
    const requestSftpId = session.sftpId ?? null;
    if (
      !canUseFiles
      || !requestSftpId
      || directoryStateSessionIdRef.current !== requestSessionId
      || directoryStateSftpIdRef.current !== requestSftpId
    ) return;
    const key = `file-operation-${crypto.randomUUID()}`;
    const label = operationLabel(operation);
    message.open({ key, type: "loading", content: `已开始${label}...`, duration: 0 });
    void onFileOperation(operation)
      .then(async (affectedDirectories) => {
        if (
          !mountedRef.current
          || sessionIdRef.current !== requestSessionId
          || directoryStateSftpIdRef.current !== requestSftpId
        ) {
          message.destroy(key);
          return;
        }
        const refreshResults = await Promise.allSettled(
          affectedDirectories.map((directory) => {
            const normalizedDirectory = normalizePath(directory);
            return normalizedDirectory === pathRef.current
              ? onRefresh()
              : loadDirectory(normalizedDirectory, true);
          }),
        );
        if (
          !mountedRef.current
          || sessionIdRef.current !== requestSessionId
          || directoryStateSftpIdRef.current !== requestSftpId
        ) {
          message.destroy(key);
          return;
        }
        message.open({ key, type: "success", content: `${label}完成`, duration: 2.5 });
        const refreshFailure = refreshResults.find((result) => result.status === "rejected");
        if (refreshFailure?.status === "rejected") {
          message.warning(`${label}已完成，但目录刷新失败：${getErrorMessage(refreshFailure.reason)}`);
        }
      })
      .catch((error) => {
        if (
          mountedRef.current
          && sessionIdRef.current === requestSessionId
          && directoryStateSftpIdRef.current === requestSftpId
        ) {
          message.open({ key, type: "error", content: `${label}失败：${getErrorMessage(error)}`, duration: 4 });
        } else {
          message.destroy(key);
        }
      });
  }

  function openCreateDialog() {
    if (!canUseFiles) return;
    setDialog({ kind: "create", entryType: "file", name: "" });
  }

  async function sendQuickCommand(command: QuickCommand) {
    if (session.state !== "connected" || !session.terminalId) {
      message.error("当前终端不可用");
      return;
    }
    const requestSessionId = session.id;
    const requestTerminalId = session.terminalId;
    try {
      await onSendCommand(command.command);
      if (
        mountedRef.current
        && activeRef.current
        && sessionIdRef.current === requestSessionId
        && sessionTerminalIdRef.current === requestTerminalId
      ) {
        message.open({ key: `quick-command-${command.id}`, type: "success", content: `已发送：${command.name}`, duration: 1.8 });
      }
    } catch (error) {
      if (
        mountedRef.current
        && activeRef.current
        && sessionIdRef.current === requestSessionId
        && sessionTerminalIdRef.current === requestTerminalId
      ) {
        message.error(getErrorMessage(error));
      }
    }
  }

  function openCommandDialog(command?: QuickCommand) {
    commandDialogRequestRef.current += 1;
    setCommandEditingId(command?.id ?? null);
    setCommandName(command?.name ?? "");
    setCommandValue(command?.command ?? "");
    setCommandDialogOpen(true);
  }

  function closeCommandDialog() {
    if (commandSaving) return;
    commandDialogRequestRef.current += 1;
    setCommandDialogOpen(false);
    setCommandEditingId(null);
  }

  async function addQuickCommand() {
    if (commandSaving) return;
    const name = commandName.trim();
    const command = commandValue.trim();
    if (!name || !command) return;
    const requestId = commandDialogRequestRef.current;
    setCommandSaving(true);
    try {
      if (commandEditingId) {
        const existing = quickCommands.find((item) => item.id === commandEditingId);
        if (!existing) throw new Error("要编辑的常用命令已不存在");
        await onQuickCommandUpsert({ ...existing, name, command, updatedAt: new Date().toISOString() });
      } else {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        await onQuickCommandUpsert({ id, name, command, createdAt: now, updatedAt: now });
      }
      if (!mountedRef.current || commandDialogRequestRef.current !== requestId) return;
      setCommandName("");
      setCommandValue("");
      setCommandEditingId(null);
      setCommandDialogOpen(false);
      message.success(commandEditingId ? "常用命令已更新" : "常用命令已添加");
    } catch (error) {
      if (mountedRef.current && commandDialogRequestRef.current === requestId) {
        message.error(`保存常用命令失败：${getErrorMessage(error)}`);
      }
    } finally {
      if (mountedRef.current && commandDialogRequestRef.current === requestId) setCommandSaving(false);
    }
  }

  function deleteQuickCommand(command: QuickCommand) {
    modal.confirm({
      title: "删除常用命令",
      content: command.name,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await onQuickCommandDelete(command.id);
          if (mountedRef.current) message.success("常用命令已删除");
        } catch (error) {
          if (mountedRef.current) message.error(`删除常用命令失败：${getErrorMessage(error)}`);
          throw error;
        }
      },
    });
  }

  function submitDialog() {
    if (!dialog) return;
    if (dialog.kind === "create") {
      const name = dialog.name.trim();
      if (!name) return;
      setDialog(null);
      startBackgroundOperation({ kind: "create", entryType: dialog.entryType, path: joinPath(path, name) });
      return;
    }
    const value = dialog.value.trim();
    if (!value) return;
    const sourcePath = dialog.entry.path || joinPath(path, dialog.entry.name);
    setDialog(null);
    if (dialog.kind === "rename") {
      startBackgroundOperation({ kind: "rename", sourcePath, targetPath: joinPath(getParentPath(sourcePath), value) });
      return;
    }
    startBackgroundOperation({ kind: dialog.kind, sourcePath, targetPath: value });
  }

  // Get the effective entries for context menu (multi-select aware)
  function getContextEntries(): RemoteFileEntry[] {
    const entry = contextMenu?.entry;
    if (!entry) return [];
    const entryKey = entry.path || joinPath(path, entry.name);
    if (selectedRowKeySet.size > 0 && selectedRowKeySet.has(entryKey)) {
      return files.filter((f) => selectedRowKeySet.has(f.path || joinPath(path, f.name)));
    }
    return [entry];
  }

  const contextEntries = getContextEntries();
  const isMulti = contextEntries.length > 1;
  const hasDirectory = contextEntries.some((e) => e.fileType === "directory");

  const contextMenuItems: MenuProps["items"] = [
    ...(!isMulti ? [{ key: "rename", label: "重命名" }] : []),
    { key: "copyPath", label: isMulti ? `复制 ${contextEntries.length} 个路径` : "复制完整路径" },
    {
      key: "download",
      label: isMulti
        ? `下载 ${contextEntries.length} 项`
        : hasDirectory
          ? "下载整个目录"
          : "下载",
    },
    ...(!isMulti ? [
      { key: "copy", label: "复制到" },
      { key: "move", label: "移动到" },
    ] : []),
    { type: "divider" },
    { key: "delete", label: isMulti ? `删除 ${contextEntries.length} 项` : "删除", danger: true },
  ];

  function handleContextMenuClick(key: string) {
    const entries = getContextEntries();
    setContextMenu(null);
    if (entries.length === 0) return;

    if (key === "rename" && entries.length === 1) {
      setDialog({ kind: "rename", entry: entries[0], value: entries[0].name });
    }
    if (key === "copyPath") {
      const paths = entries.map((e) => e.path || joinPath(path, e.name)).join("\n");
      void writeClipboardText(paths).then((ok) => {
        if (ok) message.success("已复制路径");
        else message.error("复制路径失败");
      });
    }
    if (key === "download") {
      const requestSessionId = session.id;
      const requestSftpId = session.sftpId ?? null;
      const messageKey = `prepare-download-${Date.now()}`;
      message.open({
        key: messageKey,
        type: "loading",
        content: hasDirectory ? "正在扫描远端目录…" : "正在准备下载…",
        duration: 0,
      });
      void onDownloadFiles(entries.map((entry) => ({
        remotePath: entry.path || joinPath(path, entry.name),
        fileName: entry.name,
        fileType: entry.fileType,
      }))).then(() => {
        message.destroy(messageKey);
      }).catch((error) => {
        if (
          mountedRef.current
          && activeRef.current
          && sessionIdRef.current === requestSessionId
          && directoryStateSftpIdRef.current === requestSftpId
        ) {
          message.open({
            key: messageKey,
            type: "error",
            content: `下载准备失败：${getErrorMessage(error)}`,
            duration: 6,
          });
        } else {
          message.destroy(messageKey);
        }
      });
    }
    if (key === "copy" && entries.length === 1) {
      const fp = entries[0].path || joinPath(path, entries[0].name);
      setDialog({ kind: "copy", entry: entries[0], value: getParentPath(fp) });
    }
    if (key === "move" && entries.length === 1) {
      const fp = entries[0].path || joinPath(path, entries[0].name);
      setDialog({ kind: "move", entry: entries[0], value: getParentPath(fp) });
    }
    if (key === "delete") {
      const paths = entries.map((e) => e.path || joinPath(path, e.name));
      modal.confirm({
        title: `删除${entries.length > 1 ? ` ${entries.length} 项` : ""}`,
        content: (
          <div>
            <div style={{ color: "#8c8c8c", fontSize: 12, marginBottom: 6 }}>以下内容将被永久删除：</div>
            <div className="deleteConfirmList">
              {entries.map((e) => (
                <div key={e.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {fileCategoryMeta(e).icon}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                </div>
              ))}
            </div>
          </div>
        ),
        okText: "删除",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: () => {
          startBackgroundOperation({ kind: "deleteMany", sourcePaths: paths });
          setSelectedRowKeys([]);
        },
      });
    }
  }

  const commandReady = Boolean(commandName.trim() && commandValue.trim());
  const commandLineCount = commandValue ? commandValue.split(/\r\n|\r|\n/).length : 0;

  return (
    <section className="filePanel">
      <div className="fileWorkspace">
        <QuickCommandTopArea
          dockId={quickCommandDockId}
          open={quickCommandsOpen}
          onOpenChange={(open) => {
            setContextMenu(null);
            setQuickCommandsOpen(open);
          }}
        >
            <Input
              size="small"
              placeholder="搜索文件"
              prefix={<SearchOutlined style={{ color: "#9ca3af" }} />}
              suffix={searching ? <LoadingOutlined className="fileSearchLoading" /> : null}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              allowClear
              disabled={!canUseFiles}
              style={{ width: 160 }}
            />
            <Tooltip title="新建">
              <Button
                aria-label="新建文件或目录"
                icon={<PlusOutlined />}
                size="small"
                disabled={!canUseFiles}
                onClick={openCreateDialog}
              />
            </Tooltip>
            <Tooltip title="上级目录">
              <Button
                aria-label="上级目录"
                icon={<ArrowUpOutlined />}
                size="small"
                onClick={goParent}
                disabled={!canUseFiles || path === "/"}
              />
            </Tooltip>
            <Tooltip title={canUseFiles ? "刷新" : "连接 SFTP"}>
              <Button
                aria-label={canUseFiles ? "刷新" : "连接 SFTP"}
                icon={<ReloadOutlined spin={refreshing} />}
                size="small"
                loading={refreshing}
                disabled={!canRefreshFiles}
                onClick={() => void refresh()}
              />
            </Tooltip>
        </QuickCommandTopArea>

        <div
          className={`fileContent${quickCommandsOpen ? " fileContent-quickCommandsOpen" : ""}`}
          ref={contentRef}
          style={{ "--quick-command-dock-width": `${quickCommandDockWidth}px` } as CSSProperties}
        >
          <DirectoryTree
            canUseFiles={canUseFiles}
            path={path}
            directoryEntries={directoryEntries}
            directoryExpandedKeys={directoryExpandedKeys}
            directoryLoadingKeys={directoryLoadingKeys}
            onPathChange={(p) => {
              onPathChange(p);
              setSearchText("");
              setFocusedPath(null);
              setSelectedRowKeys([]);
            }}
            onLoadDirectory={(p) => void loadDirectory(p)}
            onExpandChange={updateDirectoryExpandedKeys}
          />
          <div
            ref={tableSurfaceRef}
            className={`fileTableSurface${canUseFiles ? "" : " fileTableSurface-disabled"}`}
            onClick={() => setContextMenu(null)}
            onDragOver={(event) => {
              if (!canUseFiles) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              if (!canUseFiles) return;
              event.preventDefault();
              setDragging(false);
              const paths = droppedFilePaths(event.dataTransfer.files);
              void uploadPaths(paths);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          >
            <Table
              rowKey={(entry) => entry.path || `${path}/${entry.name}`}
              size="small"
              columns={resizableColumns}
              components={tableComponents}
              dataSource={files}
              loading={tableLoading}
              tableLayout="fixed"
              showSorterTooltip={false}
              rowSelection={{
                selectedRowKeys,
                onChange: (keys) => {
                  setContextMenu(null);
                  setSelectedRowKeys(keys.filter(isStringKey));
                },
                columnWidth: 48,
              }}
              rowClassName={(entry) => (focusedPath && entry.path === focusedPath ? "fileTableRow-focused" : "")}
              pagination={false}
              onRow={(entry) => ({
                onDoubleClick: () => openDirectory(entry),
                onContextMenu: (event) => {
                  if (!canUseFiles) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const entryKey = entry.path || joinPath(path, entry.name);
                  if (!selectedRowKeySet.has(entryKey)) {
                    setSelectedRowKeys([entryKey]);
                  }
                  const surfaceBounds = tableSurfaceRef.current?.getBoundingClientRect();
                  if (!surfaceBounds) return;
                  const position = contextMenuPositionInContainer(event.clientX, event.clientY, surfaceBounds);
                  setContextMenu({ entry, ...position });
                },
                style: { cursor: entry.fileType === "directory" ? "pointer" : "default" },
              })}
              scroll={{ x: tableScrollX, y: tableScrollY }}
              locale={{ emptyText: canUseFiles ? (searchText ? "无匹配文件" : "目录为空") : "SFTP 可用后显示文件" }}
            />
            <Dropdown
              key={contextMenu ? `${contextMenu.entry.path}:${contextMenu.x}:${contextMenu.y}` : "file-context-menu-closed"}
              open={Boolean(contextMenu)}
              disabled={!canUseFiles}
              trigger={[]}
              menu={{
                items: contextMenuItems,
                onClick: ({ key }) => handleContextMenuClick(String(key)),
              }}
              onOpenChange={(open) => {
                if (!open) setContextMenu(null);
              }}
            >
              <span
                className="fileContextMenuAnchor"
                style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }}
              />
            </Dropdown>
            {dragging && <div className="fileDropOverlay">拖放到当前目录上传</div>}
          </div>
          {quickCommandsOpen ? (
            <>
              <button
                type="button"
                className="quickCommandDockResizer"
                role="separator"
                aria-label="调整常用命令栏宽度"
                aria-orientation="vertical"
                aria-valuemin={QUICK_COMMAND_DOCK_MIN_WIDTH}
                aria-valuemax={QUICK_COMMAND_DOCK_MAX_WIDTH}
                aria-valuenow={quickCommandDockWidth}
                title="拖动调整命令栏宽度，双击恢复默认宽度"
                onMouseDown={(event) => {
                  event.preventDefault();
                  handleQuickCommandDockResizeStart(event.clientX);
                }}
                onDoubleClick={() => resizeQuickCommandDock(QUICK_COMMAND_DOCK_DEFAULT_WIDTH)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    resizeQuickCommandDock(quickCommandDockWidth + 12);
                  }
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    resizeQuickCommandDock(quickCommandDockWidth - 12);
                  }
                  if (event.key === "Home") {
                    event.preventDefault();
                    resizeQuickCommandDock(QUICK_COMMAND_DOCK_MIN_WIDTH);
                  }
                  if (event.key === "End") {
                    event.preventDefault();
                    resizeQuickCommandDock(QUICK_COMMAND_DOCK_MAX_WIDTH);
                  }
                }}
              />
              <QuickCommandDock
                id={quickCommandDockId}
                commandItems={commandItems}
                onSendCommand={sendQuickCommand}
                onEditCommand={openCommandDialog}
                onDeleteCommand={deleteQuickCommand}
              />
            </>
          ) : null}
        </div>
      </div>
      <Modal
        open={commandDialogOpen}
        className="commandDialogModal"
        title={null}
        footer={null}
        closable
        centered
        width={560}
        onCancel={closeCommandDialog}
        destroyOnHidden
      >
        <div className="commandDialogHeader">
          <div className="commandDialogHeaderIcon">
            <ThunderboltOutlined />
          </div>
          <div className="commandDialogHeaderMeta">
            <span className="commandDialogLabel">常用命令</span>
            <strong className="commandDialogTitle">
              {commandEditingId ? "编辑常用命令" : "添加常用命令"}
            </strong>
            <span className="commandDialogSubtitle">
              {commandEditingId ? "更新名称或命令内容后立即生效" : "保存后可在命令面板中一键运行"}
            </span>
          </div>
          <span className="commandDialogModeBadge">{commandEditingId ? "编辑模式" : "新建模式"}</span>
        </div>
        <div className="commandDialogContent">
          <Form layout="vertical" className="commandDialogForm" onFinish={() => void addQuickCommand()}>
            <Form.Item
              className="commandDialogNameItem"
              label={(
                <span className="commandDialogFieldHeading">
                  <span className="commandDialogFieldIcon"><TagOutlined /></span>
                  <span className="commandDialogFieldCopy">
                    <strong>命令名称</strong>
                    <small>用于在快捷命令面板中快速识别</small>
                  </span>
                  <span className="commandNameCounter">{commandName.length} / 40</span>
                </span>
              )}
            >
              <Input
                className="commandNameInput"
                autoFocus
                size="large"
                placeholder="例如：查看系统负载"
                maxLength={40}
                value={commandName}
                onChange={(event) => setCommandName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void addQuickCommand();
                }}
              />
            </Form.Item>
            <Form.Item
              className="commandDialogScriptItem"
              label={(
                <span className="commandDialogFieldHeading">
                  <span className="commandDialogFieldIcon code"><CodeOutlined /></span>
                  <span className="commandDialogFieldCopy">
                    <strong>运行脚本</strong>
                    <small>支持单行命令或多行 Shell 脚本</small>
                  </span>
                </span>
              )}
            >
              <div className="commandScriptEditor">
                <div className="commandScriptToolbar">
                  <span className="commandScriptDots" aria-hidden="true"><i /><i /><i /></span>
                  <span className="commandScriptLanguage">SHELL</span>
                  <span className="commandScriptStats">{commandLineCount} 行 · {commandValue.length} 字符</span>
                </div>
                <Input.TextArea
                  className="commandDialogTextarea"
                  autoSize={{ minRows: 7, maxRows: 14 }}
                  placeholder={"# 例如：\ntop -bn1 | head -n 20"}
                  value={commandValue}
                  onChange={(event) => setCommandValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
                    event.preventDefault();
                    void addQuickCommand();
                  }}
                />
              </div>
            </Form.Item>
          </Form>
          <div className="commandDialogTip">
            <InfoCircleOutlined />
            <span>命令会发送到当前已连接的终端执行，请确认脚本内容安全可靠。</span>
            <kbd>Ctrl + Enter</kbd>
          </div>
        </div>
        <div className="commandDialogFooter">
          <span className={`commandDialogReadyState ${commandReady ? "ready" : ""}`}>
            <i />{commandReady ? "信息完整，可以保存" : "请填写命令名称和脚本"}
          </span>
          <span className="commandDialogFooterActions">
            <Button onClick={closeCommandDialog}>取消</Button>
            <Button
              type="primary"
              icon={commandEditingId ? <SaveOutlined /> : <PlusOutlined />}
              disabled={!commandReady}
              loading={commandSaving}
              onClick={() => void addQuickCommand()}
            >
              {commandEditingId ? "保存修改" : "添加命令"}
            </Button>
          </span>
        </div>
      </Modal>
      <FileDialogs
        dialog={dialog}
        currentPath={path}
        treeData={treeData}
        directoryExpandedKeys={directoryExpandedKeys}
        onDialogChange={setDialog}
        onSubmit={submitDialog}
        onLoadDirectory={(p) => void loadDirectory(p)}
        onTreeSelect={(selectedPath) => {
          const np = normalizePath(selectedPath);
          setDialog((d) => d && (d.kind === "copy" || d.kind === "move") ? { ...d, value: np } : d);
        }}
      />
    </section>
  );
}

export const FileManager = memo(FileManagerView, (previous, next) => (
  previous.active === next.active
  && previous.filesLoading === next.filesLoading
  && previous.quickCommands === next.quickCommands
  && previous.session.id === next.session.id
  && previous.session.name === next.session.name
  && previous.session.host === next.session.host
  && previous.session.state === next.session.state
  && previous.session.connectionId === next.session.connectionId
  && previous.session.terminalId === next.session.terminalId
  && previous.session.sftpId === next.session.sftpId
  && previous.session.currentPath === next.session.currentPath
  && previous.session.filesPath === next.session.filesPath
  && previous.session.files === next.session.files
));

function resolveStateAction<T>(action: SetStateAction<T>, current: T): T {
  return typeof action === "function" ? (action as (value: T) => T)(current) : action;
}
