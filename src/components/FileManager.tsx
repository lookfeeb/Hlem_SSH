import {
  ArrowUpOutlined,
  CodeOutlined,
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { writeClipboardText } from "../lib/clipboard";
import { formatFileSize } from "../lib/format";
import { getErrorMessage } from "../lib/configMapping";
import { readJsonStorage, writeJsonStorage } from "../lib/storage";
import { EDITOR_CHANNEL_NAME, type EditorChannelMessage } from "../lib/editorChannel";
import { getBaseName, getParentPath, joinPath, normalizePath } from "../lib/path";
import { isTauriRuntime } from "../api/runtime";
import { useMountedRef } from "../lib/reactLifecycle";
import { sortRemoteEntries, compareEntryGroup, compareEntryName, formatBeijingModifiedTime } from "../lib/fileClassify";
import { fileCategoryMeta } from "./fileManager/fileIcons";
import { QuickCommandTopArea } from "./fileManager/QuickCommandPanel";
import { FileDialogs, operationLabel, type FileDialogState } from "./fileManager/FileDialogs";
import { DirectoryTree, buildTreeData, getDirectoryAncestorPaths, uniqueKeys } from "./fileManager/DirectoryTree";
import type { QuickCommand, RemoteFileEntry, RemoteSession } from "../types";


interface FileManagerProps {
  session: RemoteSession;
  onPathChange: (path: string) => void;
  onRefresh: () => Promise<void>;
  onRemoteSearch: (query: string) => Promise<string | null>;
  onListDirectory: (path: string) => Promise<RemoteFileEntry[]>;
  onFileOperation: (operation: FileOperation) => Promise<void>;
  onUploadFiles: (localPaths: string[], targetDirectory: string) => Promise<void>;
  onDownloadFiles: (files: { remotePath: string; fileName: string }[]) => Promise<void>;
  onReadText: (path: string, sessionId?: string) => Promise<string>;
  onWriteText: (path: string, content: string, sessionId?: string) => Promise<void>;
  onSendCommand: (command: string) => Promise<void>;
  quickCommands: QuickCommand[];
  onQuickCommandsChange: (commands: QuickCommand[]) => Promise<void>;
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
  type: 80,
  modifiedAt: 190,
  permissions: 112,
  owner: 96,
};
const MIN_COLUMN_WIDTH = 64;

const COLUMN_WIDTHS_KEY = "helm:fileColumnWidths";

function loadColumnWidths(): Record<string, number> {
  return readJsonStorage<Record<string, number>>(COLUMN_WIDTHS_KEY, { ...DEFAULT_COLUMN_WIDTHS }, normalizeColumnWidths);
}

function normalizeColumnWidths(value: unknown): Record<string, number> {
  const widths = { ...DEFAULT_COLUMN_WIDTHS };
  if (!value || typeof value !== "object") return widths;
  for (const [key, rawWidth] of Object.entries(value)) {
    if (!(key in DEFAULT_COLUMN_WIDTHS) || typeof rawWidth !== "number" || !Number.isFinite(rawWidth)) continue;
    widths[key] = Math.max(MIN_COLUMN_WIDTH, rawWidth);
  }
  return widths;
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

function firstDetachedEditorChannel(channels: Map<string, BroadcastChannel>): BroadcastChannel | null {
  return channels.values().next().value ?? null;
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

export function FileManager({
  session,
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
  onQuickCommandsChange,
  filesLoading = false,
}: FileManagerProps) {
  const { message, modal } = AntdApp.useApp();
  const [searchText, setSearchText] = useState("");
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [tableScrollY, setTableScrollY] = useState(180);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<FileDialogState | null>(null);
  const [directoryEntries, setDirectoryEntries] = useState<Record<string, RemoteFileEntry[]>>({});
  const [directoryLoadingKeys, setDirectoryLoadingKeys] = useState<string[]>([]);
  const [directoryExpandedKeys, setDirectoryExpandedKeys] = useState<string[]>(["/"]);
  const [dragging, setDragging] = useState(false);
  const [openingEditorPath, setOpeningEditorPath] = useState<string | null>(null);
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [commandEditingId, setCommandEditingId] = useState<string | null>(null);
  const [commandName, setCommandName] = useState("");
  const [commandValue, setCommandValue] = useState("");
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => ({ ...inMemoryColumnWidths }));
  const [tableSurfaceWidth, setTableSurfaceWidth] = useState(0);
  const columnWidthsRef = useRef(columnWidths);
  const mountedRef = useMountedRef();
  useEffect(() => {
    columnWidthsRef.current = columnWidths;
    inMemoryColumnWidths = columnWidths;
    writeJsonStorage(COLUMN_WIDTHS_KEY, columnWidths);
  }, [columnWidths]);
  const contentRef = useRef<HTMLDivElement>(null);
  const tableSurfaceRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);
  const directoryExpandedKeysRef = useRef<string[]>(["/"]);
  const detachedEditorsRef = useRef<Map<string, BroadcastChannel>>(new Map());
  const columnResizeCleanupRef = useRef<(() => void) | null>(null);
  const path = normalizePath(session.currentPath);
  const canUseFiles = session.state === "connected" && Boolean(session.sftpId);
  const canRefreshFiles = canUseFiles || (session.state === "connected" && Boolean(session.connectionId));
  const allFiles = useMemo(() => sortRemoteEntries(session.files), [session.files]);
  const lowerSearchText = searchText.toLowerCase();
  const files = useMemo(
    () => (lowerSearchText ? allFiles.filter((f) => f.name.toLowerCase().includes(lowerSearchText)) : allFiles),
    [allFiles, lowerSearchText],
  );
  const filesMatchCurrentPath = filesBelongToDirectory(allFiles, path);
  const directoryChanging = canUseFiles && (filesLoading || !filesMatchCurrentPath);
  const tableLoading = searching || refreshing || directoryChanging;
  const treeData = useMemo(() => buildTreeData(directoryEntries, path, new Set(directoryLoadingKeys)), [directoryEntries, path, directoryLoadingKeys]);
  const commandItems = useMemo(
    () =>
      [...quickCommands]
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")),
    [quickCommands],
  );

  const handleColumnResizeStart = useCallback((key: string, startX: number) => {
    columnResizeCleanupRef.current?.();
    const startWidth = columnWidthsRef.current[key] ?? DEFAULT_COLUMN_WIDTHS[key] ?? 100;
    function onMove(event: MouseEvent) {
      const next = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + event.clientX - startX));
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

  const resizableColumns = useMemo<ColumnsType<RemoteFileEntry>>(
    () =>
      baseColumns.map((column) => {
        const key = fileColumnKey(column);
        if (!key) return column;
        const headerCellProps: ResizableHeaderCellProps = {
          columnKey: key,
          onStartResize: handleColumnResizeStart,
        };
        const col = {
          ...column,
          width: columnWidths[key] ?? DEFAULT_COLUMN_WIDTHS[key],
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
    [columnWidths, handleColumnResizeStart, path],
  );

  const tableColumnWidth = useMemo(
    () => 48 + Object.keys(DEFAULT_COLUMN_WIDTHS).reduce((sum, key) => sum + (columnWidths[key] ?? DEFAULT_COLUMN_WIDTHS[key]), 0),
    [columnWidths],
  );
  const tableScrollX = useMemo(
    () => Math.max(tableColumnWidth, tableSurfaceWidth > 0 ? Math.ceil(tableSurfaceWidth) + 12 : 0),
    [tableColumnWidth, tableSurfaceWidth],
  );
  const selectedRowKeySet = useMemo(() => new Set(selectedRowKeys), [selectedRowKeys]);

  useEffect(() => {
    directoryExpandedKeysRef.current = directoryExpandedKeys;
  }, [directoryExpandedKeys]);

  useEffect(() => {
    return () => {
      columnResizeCleanupRef.current?.();
      columnResizeCleanupRef.current = null;
      detachedEditorsRef.current.forEach((channel) => channel.close());
      detachedEditorsRef.current.clear();
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
    if (!canUseFiles) {
      setSearching(false);
      setFocusedPath(null);
      setDirectoryEntries({});
      setDirectoryLoadingKeys([]);
      setDirectoryExpandedKeys(["/"]);
      return;
    }
    if (filesMatchCurrentPath) {
      setDirectoryEntries((current) => ({ ...current, [path]: allFiles }));
    }
    setDirectoryExpandedKeys((current) => uniqueKeys([...current, ...getDirectoryAncestorPaths(path)]));
    if (path !== "/" && !directoryEntries["/"]) void loadDirectory("/");
  }, [allFiles, canUseFiles, path]);

  async function loadDirectory(directoryPath: string, force = false) {
    if (!canUseFiles) return;
    const targetPath = normalizePath(directoryPath);
    if (!force && directoryEntries[targetPath]) return;
    setDirectoryLoadingKeys((current) => uniqueKeys([...current, targetPath]));
    try {
      const entries = targetPath === path && filesBelongToDirectory(allFiles, targetPath)
        ? allFiles
        : await onListDirectory(targetPath);
      if (!mountedRef.current) return;
      setDirectoryEntries((current) => ({ ...current, [targetPath]: sortRemoteEntries(entries) }));
    } catch (error) {
      if (mountedRef.current) message.error(getErrorMessage(error));
    } finally {
      if (mountedRef.current) {
        setDirectoryLoadingKeys((current) => current.filter((key) => key !== targetPath));
      }
    }
  }

  function toggleDirectory(directoryPath: string) {
    const targetPath = normalizePath(directoryPath);
    const isExpanded = directoryExpandedKeysRef.current.includes(targetPath);
    setDirectoryExpandedKeys((current) =>
      current.includes(targetPath) ? current.filter((key) => key !== targetPath) : uniqueKeys([...current, targetPath]),
    );
    if (!isExpanded) void loadDirectory(targetPath);
  }

  useEffect(() => {
    if (!canUseFiles) {
      setSearching(false);
      setFocusedPath(null);
      return;
    }
    const query = searchText.trim();
    const seq = searchSeq.current + 1;
    searchSeq.current = seq;
    if (!query) {
      setSearching(false);
      setFocusedPath(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearching(true);
      void onRemoteSearch(query)
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
    return () => window.clearTimeout(timer);
  }, [canUseFiles, searchText]);

  useEffect(() => {
    if (!canUseFiles) return;
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
  }, [canUseFiles, path]);

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
    if (openingEditorPath) return;

    const sessionId = session.id;
    const sessionName = session.name || session.host;

    setOpeningEditorPath(targetPath);
    const messageKey = `editor-open-${targetPath}`;
    let createdChannel: BroadcastChannel | null = null;
    message.open({ key: messageKey, type: "loading", content: "正在读取文件...", duration: 0 });
    try {
      const content = await onReadText(targetPath, sessionId);
      if (!mountedRef.current) return;

      const existingChannel = firstDetachedEditorChannel(detachedEditorsRef.current);
      if (existingChannel) {
        if (postEditorMessage(existingChannel, { type: "addTab", path: targetPath, content, sessionId, sessionName })) {
          message.destroy(messageKey);
          return;
        }
        existingChannel.close();
        detachedEditorsRef.current.delete(EDITOR_CHANNEL_NAME);
      }

      const channel = new BroadcastChannel(EDITOR_CHANNEL_NAME);
      createdChannel = channel;
      detachedEditorsRef.current.set(EDITOR_CHANNEL_NAME, channel);
      channel.onmessage = (event: MessageEvent<EditorChannelMessage>) => {
        const payload = event.data;
        if (payload.type === "ready") {
          postEditorMessage(channel, { type: "init", path: targetPath, content, sessionId, sessionName });
        }
        if (payload.type === "save") {
          void onWriteText(payload.path, payload.content, payload.sessionId)
            .then(() => {
              if (detachedEditorsRef.current.get(EDITOR_CHANNEL_NAME) === channel) {
                postEditorMessage(channel, { type: "saved", path: payload.path, sessionId: payload.sessionId });
              }
            })
            .catch((error) => {
              if (detachedEditorsRef.current.get(EDITOR_CHANNEL_NAME) === channel) {
                postEditorMessage(channel, { type: "error", message: getErrorMessage(error), path: payload.path, sessionId: payload.sessionId });
              }
            });
        }
        if (payload.type === "close") {
          channel.close();
          detachedEditorsRef.current.delete(EDITOR_CHANNEL_NAME);
        }
      };

      if (isTauriRuntime()) {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        if (!mountedRef.current) return;
        const windowLabel = `editor-global`;
        const existingWindow = await WebviewWindow.getByLabel(windowLabel);
        if (!mountedRef.current) return;
        if (existingWindow) {
          postEditorMessage(channel, { type: "addTab", path: targetPath, content, sessionId, sessionName });
          try {
            await existingWindow.setFocus();
          } catch (error) {
            console.warn("[helm] failed to focus editor window:", getErrorMessage(error));
          }
          if (mountedRef.current) message.destroy(messageKey);
          return;
        }
        const webview = new WebviewWindow(windowLabel, {
          url: `index.html?editorWindow=${encodeURIComponent(EDITOR_CHANNEL_NAME)}`,
          title: `文件编辑器`,
          width: 1100,
          height: 760,
          minWidth: 760,
          minHeight: 520,
          resizable: true,
        });
        await webview.once("tauri://error", (event) => {
          if (detachedEditorsRef.current.get(EDITOR_CHANNEL_NAME) === channel) {
            channel.close();
            detachedEditorsRef.current.delete(EDITOR_CHANNEL_NAME);
          }
          if (mountedRef.current) message.error(getErrorMessage(event.payload));
        });
      } else {
        window.open(`${window.location.origin}${window.location.pathname}?editorWindow=${encodeURIComponent(EDITOR_CHANNEL_NAME)}`, `editor-global`, "width=1100,height=760");
      }
      if (mountedRef.current) message.destroy(messageKey);
    } catch (error) {
      if (createdChannel && detachedEditorsRef.current.get(EDITOR_CHANNEL_NAME) === createdChannel) {
        createdChannel.close();
        detachedEditorsRef.current.delete(EDITOR_CHANNEL_NAME);
      }
      if (mountedRef.current) {
        message.open({ key: messageKey, type: "error", content: getErrorMessage(error), duration: 3 });
      }
    } finally {
      if (mountedRef.current) setOpeningEditorPath(null);
    }
  }

  async function uploadPaths(localPaths: string[]) {
    if (!canUseFiles) return;
    if (localPaths.length === 0) return;
    try {
      await onUploadFiles(localPaths, path);
      if (mountedRef.current) message.success(`已开始上传 ${localPaths.length} 个文件`);
    } catch (error) {
      if (mountedRef.current) message.error(getErrorMessage(error));
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
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  async function refresh() {
    if (!canRefreshFiles) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }

  function startBackgroundOperation(operation: FileOperation) {
    if (!canUseFiles) return;
    const key = `file-operation-${crypto.randomUUID()}`;
    const label = operationLabel(operation);
    message.open({ key, type: "loading", content: `已开始${label}...`, duration: 0 });
    void onFileOperation(operation)
      .then(() => {
        if (mountedRef.current) message.open({ key, type: "success", content: `${label}完成`, duration: 2.5 });
      })
      .catch((error) => {
        if (mountedRef.current) {
          message.open({ key, type: "error", content: `${label}失败：${getErrorMessage(error)}`, duration: 4 });
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
    try {
      await onSendCommand(command.command);
      void onQuickCommandsChange(
        quickCommands.map((item) =>
          item.id === command.id ? { ...item, clickCount: (item.clickCount ?? 0) + 1, updatedAt: new Date().toISOString() } : item,
        ),
      );
      message.open({ key: `quick-command-${command.id}`, type: "success", content: `已发送：${command.name}`, duration: 1.8 });
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  function openCommandDialog(command?: QuickCommand) {
    setCommandEditingId(command?.id ?? null);
    setCommandName(command?.name ?? "");
    setCommandValue(command?.command ?? "");
    setCommandDialogOpen(true);
  }

  function addQuickCommand() {
    const name = commandName.trim();
    const command = commandValue.trim();
    if (!name || !command) return;
    if (commandEditingId) {
      void onQuickCommandsChange(
        quickCommands.map((item) =>
          item.id === commandEditingId ? { ...item, name, command, updatedAt: new Date().toISOString() } : item,
        ),
      );
    } else {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      void onQuickCommandsChange([...quickCommands, { id, name, command, clickCount: 0, createdAt: now, updatedAt: now }].slice(-100));
    }
    setCommandName("");
    setCommandValue("");
    setCommandEditingId(null);
    setCommandDialogOpen(false);
  }

  function deleteQuickCommand(command: QuickCommand) {
    modal.confirm({
      title: "删除常用命令",
      content: command.name,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        void onQuickCommandsChange(quickCommands.filter((item) => item.id !== command.id));
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
    ...(!hasDirectory ? [{ key: "download", label: isMulti ? `下载 ${contextEntries.length} 个文件` : "下载" }] : []),
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
      const downloadEntries = entries.filter((e) => e.fileType !== "directory");
      if (downloadEntries.length > 0) {
        onDownloadFiles(downloadEntries.map((e) => ({
          remotePath: e.path || joinPath(path, e.name),
          fileName: e.name,
        })));
      }
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

  return (
    <section className="filePanel">
      <div className="fileWorkspace">
        <QuickCommandTopArea
          commandItems={commandItems}
          onSendCommand={sendQuickCommand}
          onEditCommand={openCommandDialog}
          onDeleteCommand={deleteQuickCommand}
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

        <div className="fileContent" ref={contentRef}>
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
            onExpandChange={(keys) => setDirectoryExpandedKeys(keys)}
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
                onChange: (keys) => setSelectedRowKeys(keys.filter(isStringKey)),
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
                  setContextMenu(null);
                  setContextMenu({ entry, x: event.clientX, y: event.clientY });
                },
                style: { cursor: entry.fileType === "directory" ? "pointer" : "default" },
              })}
              scroll={{ x: tableScrollX, y: tableScrollY }}
              locale={{ emptyText: canUseFiles ? (searchText ? "无匹配文件" : "目录为空") : "SFTP 可用后显示文件" }}
            />
            <Dropdown
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
        </div>
      </div>
      <Modal
        open={commandDialogOpen}
        className="commandDialogModal"
        title={null}
        footer={null}
        closable
        width={460}
        onCancel={() => {
          setCommandDialogOpen(false);
          setCommandEditingId(null);
        }}
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
        </div>
        <Form layout="vertical" className="commandDialogForm" onFinish={addQuickCommand}>
          <Form.Item label={<span className="commandDialogFieldLabel"><TagOutlined /> 名称</span>}>
            <div className="commandNameField">
              <input
                className="commandNameInput"
                autoFocus
                placeholder="例如：查看系统负载"
                maxLength={40}
                value={commandName}
                onChange={(event) => setCommandName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addQuickCommand();
                }}
              />
              <span className="commandNameCounter">{commandName.length} / 40</span>
            </div>
          </Form.Item>
          <Form.Item label={<span className="commandDialogFieldLabel"><CodeOutlined /> 运行脚本</span>}>
            <Input.TextArea
              className="commandDialogTextarea"
              autoSize={{ minRows: 6, maxRows: 14 }}
              placeholder={"# 例如：\ntop -bn1 | head -n 20"}
              value={commandValue}
              onChange={(event) => setCommandValue(event.target.value)}
            />
          </Form.Item>
        </Form>
        <div className="commandDialogFooter">
          <Button
            onClick={() => {
              setCommandDialogOpen(false);
              setCommandEditingId(null);
            }}
          >
            取消
          </Button>
          <Button
            type="primary"
            icon={commandEditingId ? <SaveOutlined /> : <PlusOutlined />}
            onClick={addQuickCommand}
          >
            {commandEditingId ? "保存" : "添加"}
          </Button>
        </div>
      </Modal>
      <FileDialogs
        dialog={dialog}
        treeData={treeData}
        directoryExpandedKeys={directoryExpandedKeys}
        onDialogChange={setDialog}
        onSubmit={submitDialog}
        onLoadDirectory={(p) => void loadDirectory(p)}
        onExpandChange={(keys) => setDirectoryExpandedKeys(keys)}
        onTreeSelect={(selectedPath) => {
          const np = normalizePath(selectedPath);
          setDialog((d) => d && (d.kind === "copy" || d.kind === "move") ? { ...d, value: np } : d);
          toggleDirectory(np);
        }}
      />
    </section>
  );
}

function filesBelongToDirectory(files: RemoteFileEntry[], directoryPath: string) {
  const normalizedDirectory = normalizePath(directoryPath);
  return files.every((entry) => {
    if (!entry.path) return true;
    return getParentPath(entry.path) === normalizedDirectory;
  });
}


