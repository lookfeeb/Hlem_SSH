import {
  AimOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckOutlined,
  CompressOutlined,
  CopyOutlined,
  DeleteOutlined,
  FileAddOutlined,
  RetweetOutlined,
  SearchOutlined,
  SwapOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import CodeMirror from "@uiw/react-codemirror";
import { undo as undoCommand, undoDepth } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { go } from "@codemirror/legacy-modes/mode/go";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { c, cpp, java, csharp, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { EditorSelection, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { searchKeymap } from "@codemirror/search";
import { Button, Input, Space, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import { detectFileLanguage, type FileLanguageId } from "../lib/fileLanguage";
import { useTimeoutRegistry } from "../lib/reactLifecycle";

interface CodeEditorProps {
  path: string;
  value: string;
  readOnly?: boolean;
  height?: string;
  minHeight?: string;
  maxHeight?: string;
  onChange: (value: string) => void;
  onFormatJson?: (value: string) => void;
}

const LARGE_DOC_BYTES = 200_000;
const LARGE_DOC_LINES = 3_000;

export function CodeEditor({
  path,
  value,
  readOnly = false,
  height,
  minHeight = height ? "0" : "320px",
  maxHeight = height ? "none" : "calc(100vh - 220px)",
  onChange,
  onFormatJson,
}: CodeEditorProps) {
  const viewRef = useRef<EditorView | null>(null);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [line, setLine] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [copied, setCopied] = useState(false);
  const setSafeTimeout = useTimeoutRegistry();
  const largeDocument = useMemo(() => isLargeDocument(value), [value]);

  useEffect(() => {
    setCanUndo(false);
    canUndoRef.current = false;
  }, [path]);
  const canUndoRef = useRef(false);
  const undoTracker = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.transactions.some((tr) => tr.annotation !== undefined)) {
          const depth = undoDepth(update.state);
          if (depth > 0 !== canUndoRef.current) {
            canUndoRef.current = depth > 0;
            setCanUndo(depth > 0);
          }
        }
      }),
    [],
  );
  const detectedLanguage = useMemo(() => detectFileLanguage(path, value), [path, value]);
  const extensions = useMemo(
    () => [languageExtension(detectedLanguage.id), EditorView.lineWrapping, keymap.of(searchKeymap), undoTracker].filter(isExtension),
    [detectedLanguage.id, undoTracker],
  );
  const canFormatJson = detectedLanguage.id === "json";

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".codeEditorContextMenu")) return;
      setContextMenu(null);
    };
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", closeOnPointer, true);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointer, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  function selectRange(from: number, to: number) {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    view.focus();
  }

  function findNext(direction: 1 | -1 = 1) {
    if (!query) return;
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    const selection = view.state.selection.main;
    const start = direction > 0 ? selection.to : selection.from;
    const needle = query.toLowerCase();
    const haystack = text.toLowerCase();
    let index = direction > 0
      ? haystack.indexOf(needle, start)
      : haystack.lastIndexOf(needle, Math.max(0, start - 1));
    if (index < 0) {
      index = direction > 0 ? haystack.indexOf(needle, 0) : haystack.lastIndexOf(needle);
    }
    if (index >= 0) selectRange(index, index + query.length);
  }

  function replaceCurrent() {
    const view = viewRef.current;
    if (!view || !query) return;
    const selection = view.state.selection.main;
    const selected = view.state.sliceDoc(selection.from, selection.to);
    if (selected.toLowerCase() !== query.toLowerCase()) {
      findNext(1);
      return;
    }
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: replacement },
      selection: EditorSelection.cursor(selection.from + replacement.length),
    });
    onChange(view.state.doc.toString());
    setSafeTimeout(() => findNext(1), 0);
  }

  function replaceAll() {
    if (!query) return;
    onChange(value.split(query).join(replacement));
  }

  function goLine() {
    const view = viewRef.current;
    const target = Number(line);
    if (!view || !Number.isFinite(target) || target <= 0) return;
    const docLine = view.state.doc.line(Math.min(target, view.state.doc.lines));
    selectRange(docLine.from, docLine.from);
  }

  function formatJson() {
    if (!onFormatJson) return;
    onFormatJson(JSON.stringify(JSON.parse(value), null, 2));
  }

  function undoLastEdit() {
    const view = viewRef.current;
    if (!view || readOnly) return;
    if (undoCommand(view)) {
      const depth = undoDepth(view.state);
      setCanUndo(depth > 0);
      canUndoRef.current = depth > 0;
      view.focus();
    }
  }

  function selectionText() {
    const view = viewRef.current;
    if (!view) return "";
    const selection = view.state.selection.main;
    if (!selection.empty) return view.state.sliceDoc(selection.from, selection.to);
    return view.state.doc.lineAt(selection.from).text;
  }

  async function copyEditorText(text = selectionText()) {
    if (text) await writeClipboardText(text);
  }

  async function cutEditorText() {
    const view = viewRef.current;
    if (!view || readOnly) return;
    const selection = view.state.selection.main;
    await copyEditorText();
    if (!selection.empty) {
      view.dispatch({ changes: { from: selection.from, to: selection.to, insert: "" } });
      return;
    }
    deleteCurrentLine();
  }

  async function pasteEditorText() {
    const view = viewRef.current;
    if (!view || readOnly) return;
    const text = await readClipboardText();
    if (!text) return;
    const selection = view.state.selection.main;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: text },
      selection: EditorSelection.cursor(selection.from + text.length),
    });
    view.focus();
  }

  function selectAllText() {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ selection: EditorSelection.single(0, view.state.doc.length) });
    view.focus();
  }

  function currentLineBounds() {
    const view = viewRef.current;
    if (!view) return null;
    const line = view.state.doc.lineAt(view.state.selection.main.from);
    let from = line.from;
    let to = line.to;
    if (line.number < view.state.doc.lines) to += 1;
    else if (from > 0) from -= 1;
    return { line, from, to };
  }

  function deleteCurrentLine() {
    const view = viewRef.current;
    if (!view || readOnly) return;
    const bounds = currentLineBounds();
    if (!bounds) return;
    view.dispatch({
      changes: { from: bounds.from, to: bounds.to, insert: "" },
      selection: EditorSelection.cursor(Math.min(bounds.from, view.state.doc.length)),
    });
    view.focus();
  }

  function duplicateCurrentLine() {
    const view = viewRef.current;
    if (!view || readOnly) return;
    const line = view.state.doc.lineAt(view.state.selection.main.from);
    const insert = `${line.number === view.state.doc.lines ? "\n" : ""}${line.text}\n`;
    view.dispatch({
      changes: { from: line.to, to: line.to, insert },
      selection: EditorSelection.cursor(line.to + insert.length),
    });
    view.focus();
  }

  function handleContextMenuClick(key: string) {
    setContextMenu(null);
    if (key === "copy") void copyEditorText();
    else if (key === "cut") void cutEditorText();
    else if (key === "paste") void pasteEditorText();
    else if (key === "selectAll") selectAllText();
    else if (key === "copyLine") void copyEditorText(currentLineBounds()?.line.text ?? "");
    else if (key === "duplicateLine") duplicateCurrentLine();
    else if (key === "deleteLine") deleteCurrentLine();
    else if (key === "formatJson") formatJson();
  }

  return (
    <div
      className="codeEditorShell"
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu(clampContextMenuPosition(event.clientX, event.clientY));
      }}
    >
      {contextMenu && (
        <div
          className="codeEditorContextMenu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button type="button" onClick={() => handleContextMenuClick("copy")}>
            <CopyOutlined />
            <span>复制</span>
          </button>
          <button type="button" disabled={readOnly} onClick={() => handleContextMenuClick("cut")}>
            <span className="codeEditorMenuIconSlot" />
            <span>剪切</span>
          </button>
          <button type="button" disabled={readOnly} onClick={() => handleContextMenuClick("paste")}>
            <span className="codeEditorMenuIconSlot" />
            <span>粘贴</span>
          </button>
          <button type="button" onClick={() => handleContextMenuClick("selectAll")}>
            <span className="codeEditorMenuIconSlot" />
            <span>全选</span>
          </button>
          <div className="codeEditorContextDivider" />
          <button type="button" onClick={() => handleContextMenuClick("copyLine")}>
            <CopyOutlined />
            <span>复制当前行</span>
          </button>
          <button type="button" disabled={readOnly} onClick={() => handleContextMenuClick("duplicateLine")}>
            <FileAddOutlined />
            <span>重复当前行</span>
          </button>
          <button type="button" className="codeEditorContextDanger" disabled={readOnly} onClick={() => handleContextMenuClick("deleteLine")}>
            <DeleteOutlined />
            <span>删除当前行</span>
          </button>
          {canFormatJson && (
            <>
              <div className="codeEditorContextDivider" />
              <button type="button" disabled={readOnly} onClick={() => handleContextMenuClick("formatJson")}>
                <CompressOutlined />
                <span>格式化 JSON</span>
              </button>
            </>
          )}
        </div>
      )}
      <div className="codeEditorToolbar">
        <Space size={5} wrap className="codeEditorToolbarGroup codeEditorToolbarSearchGroup">
          <Input
            size="small"
            className="codeEditorInput"
            prefix={<SearchOutlined />}
            placeholder="搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onPressEnter={() => findNext(1)}
          />
          <Tooltip title="上一个匹配">
            <Button aria-label="上一个匹配" size="small" icon={<ArrowUpOutlined />} onClick={() => findNext(-1)} />
          </Tooltip>
          <Tooltip title="下一个匹配">
            <Button aria-label="下一个匹配" size="small" icon={<ArrowDownOutlined />} onClick={() => findNext(1)} />
          </Tooltip>
          <Input
            size="small"
            className="codeEditorInput"
            placeholder="替换为"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
          />
          <Tooltip title="替换当前匹配">
            <Button aria-label="替换当前匹配" size="small" icon={<SwapOutlined />} disabled={readOnly} onClick={replaceCurrent} />
          </Tooltip>
          <Tooltip title="全部替换">
            <Button aria-label="全部替换" size="small" icon={<RetweetOutlined />} disabled={readOnly} onClick={replaceAll} />
          </Tooltip>
          <Input
            size="small"
            className="codeEditorLineInput"
            placeholder="行号"
            value={line}
            onChange={(event) => setLine(event.target.value)}
            onPressEnter={goLine}
          />
          <Tooltip title="跳转到行号">
            <Button aria-label="跳转到行号" size="small" icon={<AimOutlined />} onClick={goLine} />
          </Tooltip>
        </Space>
        <Space size={5} className="codeEditorToolbarGroup codeEditorToolbarActionGroup">
          <Tooltip title="撤销上一步 (Ctrl+Z)">
            <Button
              aria-label="撤销上一步"
              size="small"
              icon={<UndoOutlined />}
              disabled={readOnly || !canUndo}
              onClick={undoLastEdit}
            />
          </Tooltip>
          <Tooltip title={copied ? "已复制" : "复制全部内容"}>
            <Button
              aria-label="复制全部内容"
              size="small"
              icon={copied ? <CheckOutlined style={{ color: "#52c41a" }} /> : <CopyOutlined />}
              onClick={() => {
                void writeClipboardText(value ?? "").then((ok) => {
                  if (!ok) return;
                  setCopied(true);
                  setSafeTimeout(() => setCopied(false), 1500);
                });
              }}
            />
          </Tooltip>
          {canFormatJson && (
            <Tooltip title="格式化 JSON">
              <Button size="small" icon={<CompressOutlined />} disabled={readOnly} onClick={formatJson} />
            </Tooltip>
          )}
        </Space>
      </div>
      <CodeMirror
        value={value}
        height={height}
        minHeight={minHeight}
        maxHeight={maxHeight}
        editable={!readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: !largeDocument,
          highlightActiveLine: true,
          highlightSelectionMatches: !largeDocument,
        }}
        extensions={extensions}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        onChange={(next) => onChange(next)}
        theme="light"
      />
    </div>
  );
}

function isLargeDocument(value: string) {
  if (value.length > LARGE_DOC_BYTES) return true;
  let lines = 1;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > LARGE_DOC_LINES) return true;
    }
  }
  return false;
}

function languageExtension(language: FileLanguageId): Extension | null {
  switch (language) {
    case "shell": return StreamLanguage.define(shell);
    case "dockerfile": return StreamLanguage.define(dockerFile);
    case "makefile":
    case "configuration": return StreamLanguage.define(properties);
    case "nginx": return StreamLanguage.define(nginx);
    case "json": return json();
    case "javascript": return javascript({ jsx: true });
    case "typescript": return javascript({ jsx: true, typescript: true });
    case "markup": return html();
    case "css": return css();
    case "python": return python();
    case "sql": return sql();
    case "yaml": return yaml();
    case "toml": return StreamLanguage.define(toml);
    case "ruby": return StreamLanguage.define(ruby);
    case "go": return StreamLanguage.define(go);
    case "rust": return StreamLanguage.define(rust);
    case "lua": return StreamLanguage.define(lua);
    case "perl": return StreamLanguage.define(perl);
    case "c": return StreamLanguage.define(c);
    case "cpp": return StreamLanguage.define(cpp);
    case "java": return StreamLanguage.define(java);
    case "csharp": return StreamLanguage.define(csharp);
    case "kotlin": return StreamLanguage.define(kotlin);
    case "scala": return StreamLanguage.define(scala);
    case "text": return null;
  }
}

function isExtension(extension: Extension | null): extension is Extension {
  return extension !== null;
}

function clampContextMenuPosition(x: number, y: number) {
  const width = 184;
  const height = 316;
  const padding = 8;
  return {
    x: Math.max(padding, Math.min(x, window.innerWidth - width - padding)),
    y: Math.max(padding, Math.min(y, window.innerHeight - height - padding)),
  };
}
