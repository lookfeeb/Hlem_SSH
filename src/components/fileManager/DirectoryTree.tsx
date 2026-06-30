import { FolderOutlined, LoadingOutlined } from "@ant-design/icons";
import { Tree } from "antd";
import type RcTree from "@rc-component/tree";
import type { DataNode } from "antd/es/tree";
import { useEffect, useMemo, useRef } from "react";
import { comparePathName } from "../../lib/fileClassify";
import { getParentPath, getPathSegments, joinPath, normalizePath } from "../../lib/path";
import type { RemoteFileEntry } from "../../types";

export interface DirectoryTreeProps {
  canUseFiles: boolean;
  path: string;
  directoryEntries: Record<string, RemoteFileEntry[]>;
  directoryExpandedKeys: string[];
  directoryLoadingKeys: string[];
  onPathChange: (path: string) => void;
  onLoadDirectory: (path: string) => void;
  onExpandChange: (keys: string[]) => void;
}

export function DirectoryTree({
  canUseFiles,
  path,
  directoryEntries,
  directoryExpandedKeys,
  directoryLoadingKeys,
  onPathChange,
  onLoadDirectory,
  onExpandChange,
}: DirectoryTreeProps) {
  const treeRootRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<RcTree | null>(null);
  const normalizedPath = normalizePath(path);
  const treeData = useMemo(
    () => buildTreeData(directoryEntries, normalizedPath, new Set(directoryLoadingKeys)),
    [directoryEntries, normalizedPath, directoryLoadingKeys],
  );
  const visibleTreeKeys = useMemo(
    () => flattenVisibleTreeKeys(treeData, new Set(directoryExpandedKeys)),
    [treeData, directoryExpandedKeys],
  );
  const currentTreeIndex = visibleTreeKeys.indexOf(normalizedPath);

  useEffect(() => {
    if (!canUseFiles || normalizedPath === "/" || currentTreeIndex < 0) return;
    const scrollToCurrentPath = () => {
      treeRef.current?.scrollTo({ index: currentTreeIndex, align: "top" });
      scrollSelectedDirectoryIntoView(treeRootRef.current);
    };
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToCurrentPath();
      secondFrame = window.requestAnimationFrame(scrollToCurrentPath);
    });
    const retry = window.setTimeout(scrollToCurrentPath, 120);
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(retry);
    };
  }, [canUseFiles, currentTreeIndex, normalizedPath, treeData, directoryExpandedKeys]);

  if (!canUseFiles) {
    return (
      <div className="pathTree">
        <div className="pathTreeUnavailable">
          <FolderOutlined />
          <span>SFTP 未连接</span>
        </div>
      </div>
    );
  }

  return (
    <div className="pathTree" ref={treeRootRef}>
      <button
        type="button"
        className={`pathTreeRoot${normalizedPath === "/" ? " pathTreeRoot-selected" : ""}`}
        onClick={() => {
          onPathChange("/");
          onExpandChange(uniqueKeys(["/", ...directoryExpandedKeys]));
          onLoadDirectory("/");
        }}
      >
        <FolderOutlined />
        <span>/</span>
      </button>
      <Tree
        ref={treeRef}
        className="pathTreeList"
        showIcon
        blockNode
        virtual
        expandAction={false}
        selectedKeys={normalizedPath === "/" ? [] : [normalizedPath]}
        expandedKeys={directoryExpandedKeys}
        treeData={treeData}
        switcherIcon={({ isLeaf }) => (isLeaf ? null : <span className="pathTreeChevron" />)}
        onExpand={(keys, info) => {
          onExpandChange(keys.map(String));
          if (info.expanded) onLoadDirectory(String(info.node.key));
        }}
        onClick={(event, node) => {
          if (isTreeSwitcherClick(event.target)) return;
          onPathChange(String(node.key));
        }}
      />
    </div>
  );
}

/** Also used by FileDialogs for the copy/move tree */
export { buildTreeData, getDirectoryAncestorPaths, uniqueKeys };

function buildTreeData(
  entriesByPath: Record<string, RemoteFileEntry[]>,
  currentPath: string,
  loadingKeys: Set<string>,
): DataNode[] {
  const normalizedCurrentPath = normalizePath(currentPath);
  const rootChildren = buildDirectoryChildren("/", entriesByPath, normalizedCurrentPath, loadingKeys, new Set(["/"]));
  if (rootChildren.length > 0) return rootChildren;
  return [buildDirectoryNode("/", entriesByPath, normalizedCurrentPath, loadingKeys, new Set())];
}

function flattenVisibleTreeKeys(nodes: DataNode[], expandedKeys: Set<string>) {
  const keys: string[] = [];
  const walk = (items: DataNode[]) => {
    for (const node of items) {
      const key = String(node.key);
      keys.push(key);
      if (expandedKeys.has(key) && Array.isArray(node.children)) {
        walk(node.children as DataNode[]);
      }
    }
  };
  walk(nodes);
  return keys;
}

function scrollSelectedDirectoryIntoView(root: HTMLElement | null) {
  const scrollContainer = root?.querySelector<HTMLElement>(".pathTreeList");
  if (!scrollContainer) return;
  const selectedContent = scrollContainer.querySelector<HTMLElement>(".ant-tree-node-selected");
  const selectedNode = selectedContent?.closest<HTMLElement>(".ant-tree-treenode")
    ?? scrollContainer.querySelector<HTMLElement>(".ant-tree-treenode-selected");
  if (!selectedNode) return;
  const containerRect = scrollContainer.getBoundingClientRect();
  const nodeRect = selectedNode.getBoundingClientRect();
  scrollContainer.scrollTop += nodeRect.top - containerRect.top - 6;
}

function buildDirectoryNode(
  directoryPath: string,
  entriesByPath: Record<string, RemoteFileEntry[]>,
  currentPath: string,
  loadingKeys: Set<string>,
  ancestors: Set<string>,
): DataNode {
  const normalizedPath = normalizePath(directoryPath);
  const entries = entriesByPath[normalizedPath];
  const loading = loadingKeys.has(normalizedPath);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(normalizedPath);
  const children = buildDirectoryChildren(normalizedPath, entriesByPath, currentPath, loadingKeys, nextAncestors);
  return {
    title: getDirectoryTitle(normalizedPath),
    key: normalizedPath,
    icon: loading ? <LoadingOutlined /> : <FolderOutlined />,
    isLeaf: Boolean(entries) && children.length === 0,
    ...(children.length > 0 ? { children } : {}),
  };
}

function buildDirectoryChildren(
  directoryPath: string,
  entriesByPath: Record<string, RemoteFileEntry[]>,
  currentPath: string,
  loadingKeys: Set<string>,
  ancestors: Set<string>,
): DataNode[] {
  const childPaths = new Map<string, string>();
  const entries = entriesByPath[directoryPath] ?? [];
  for (const entry of entries) {
    if (entry.fileType !== "directory") continue;
    if (!entry.name || entry.name === "." || entry.name === "..") continue;
    const childPath = normalizePath(entry.path || joinPath(directoryPath, entry.name));
    if (getParentPath(childPath) !== directoryPath) continue;
    if (childPath === directoryPath || ancestors.has(childPath)) continue;
    childPaths.set(childPath, entry.name);
  }

  const activeChildPath = getActiveChildPath(directoryPath, currentPath);
  if (activeChildPath && activeChildPath !== directoryPath && !ancestors.has(activeChildPath) && !childPaths.has(activeChildPath)) {
    childPaths.set(activeChildPath, getDirectoryTitle(activeChildPath));
  }

  return Array.from(childPaths.keys())
    .sort(comparePathName)
    .map((childPath) => buildDirectoryNode(childPath, entriesByPath, currentPath, loadingKeys, ancestors));
}

function getActiveChildPath(directoryPath: string, currentPath: string) {
  const parentSegments = getPathSegments(directoryPath);
  const currentSegments = getPathSegments(currentPath);
  if (parentSegments.length >= currentSegments.length) return null;
  if (parentSegments.some((segment, index) => segment !== currentSegments[index])) return null;
  return joinPath(directoryPath, currentSegments[parentSegments.length]);
}

function getDirectoryTitle(path: string) {
  const segments = getPathSegments(path);
  return segments[segments.length - 1] ?? "/";
}

function getDirectoryAncestorPaths(path: string) {
  const segments = getPathSegments(path);
  const paths = ["/"];
  let current = "/";
  for (const segment of segments) {
    current = joinPath(current, segment);
    paths.push(current);
  }
  return paths;
}

function uniqueKeys(keys: string[]) {
  return Array.from(new Set(keys));
}

function isTreeSwitcherClick(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest(".ant-tree-switcher"));
}
