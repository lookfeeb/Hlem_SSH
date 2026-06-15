import { Dropdown } from "antd";
import type { MenuProps } from "antd";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { appApi } from "../api/appApi";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import { useAnimationFrameRegistry } from "../lib/reactLifecycle";
import { registerTerminalSink } from "../lib/terminalRegistry";
import type { RemoteSession, TerminalEntry } from "../types";

interface TerminalPanelProps {
  session: RemoteSession;
  onSendData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onClear: () => void;
}

type AppliedTerminalState = {
  sessionKey: string;
  offsets: Map<string, number>;
};

export function TerminalPanel({ session, onSendData, onResize, onClear }: TerminalPanelProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null);
  const [commandInputValue, setCommandInputValue] = useState("");
  const requestSafeAnimationFrame = useAnimationFrameRegistry();
  const commandInputRef = useRef<HTMLInputElement>(null);
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const appliedRef = useRef<AppliedTerminalState | null>(null);
  const lastSizeRef = useRef<{ terminalId: string | null; cols: number; rows: number }>({ terminalId: null, cols: 0, rows: 0 });
  const terminalIdRef = useRef<string | null>(session.terminalId ?? null);
  const sendDataRef = useRef(onSendData);
  const resizeRef = useRef(onResize);
  const clearRef = useRef(onClear);
  const connected = session.state === "connected";
  const connectedRef = useRef(connected);

  terminalIdRef.current = session.terminalId ?? null;

  useEffect(() => {
    sendDataRef.current = onSendData;
  }, [onSendData]);

  useEffect(() => {
    resizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    clearRef.current = onClear;
  }, [onClear]);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  function fitAndResizeTerminal() {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    try {
      fitAddon.fit();
    } catch (error) {
      console.debug("[helm] failed to fit terminal:", error);
      return;
    }
    const { cols, rows } = terminal;
    const terminalId = terminalIdRef.current;
    if (!terminalId || cols <= 0 || rows <= 0) return;
    const last = lastSizeRef.current;
    if (cols !== last.cols || rows !== last.rows || terminalId !== last.terminalId) {
      lastSizeRef.current = { terminalId, cols, rows };
      resizeRef.current(cols, rows);
    }
  }

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    const terminal = new XtermTerminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      disableStdin: !connectedRef.current,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: {
        background: "#fbfdff",
        foreground: "#1f2937",
        cursor: "#2563eb",
        selectionBackground: "#bfdbfe",
        black: "#111827",
        red: "#dc2626",
        green: "#047857",
        yellow: "#b45309",
        blue: "#2563eb",
        magenta: "#7c3aed",
        cyan: "#0891b2",
        white: "#475569",
        brightBlack: "#64748b",
        brightRed: "#ef4444",
        brightGreen: "#10b981",
        brightYellow: "#d97706",
        brightBlue: "#3b82f6",
        brightMagenta: "#8b5cf6",
        brightCyan: "#06b6d4",
        brightWhite: "#0f172a",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon((_event, url) => {
      void appApi.openExternalUrl(url);
    }));
    terminal.open(host);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === "v") {
        event.preventDefault();
        void pasteToTerminal();
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && key === "l") {
        event.preventDefault();
        clearTerminal();
        return false;
      }
      return true;
    });
    const dataDisposable = terminal.onData((data) => {
      if (!connectedRef.current) return;
      sendDataRef.current(data);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => {
      requestSafeAnimationFrame(fitAndResizeTerminal);
    });
    resizeObserver.observe(host);
    requestSafeAnimationFrame(() => {
      fitAndResizeTerminal();
      terminal.focus();
    });

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      appliedRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!session.terminalId) return;
    requestSafeAnimationFrame(fitAndResizeTerminal);
  }, [session.terminalId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const sessionKey = session.id;
    if (appliedRef.current?.sessionKey !== sessionKey) {
      terminal.reset();
      appliedRef.current = { sessionKey, offsets: new Map() };
    }

    const applied = appliedRef.current;
    if (!applied) return;

    if (session.terminal.length === 0 && applied.offsets.size > 0) {
      terminal.clear();
      applied.offsets.clear();
      return;
    }

    for (const entry of session.terminal) {
      const content = terminalEntryData(entry);
      const contentLength = terminalEntryDataLength(content);
      const previousLength = applied.offsets.get(entry.id) ?? 0;
      if (previousLength < contentLength) {
        const nextContent = sliceTerminalEntryData(content, previousLength);
        writeTerminalData(terminal, nextContent);
        applied.offsets.set(entry.id, contentLength);
      }
    }
  }, [session.id, session.terminalId, session.terminal]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !session.terminalId) return;
    return registerTerminalSink(session.terminalId, {
      writeEntry: (entry) => writeTerminalEntry(terminal, entry),
      clear: () => terminal.clear(),
      reset: () => terminal.reset(),
    });
  }, [session.terminalId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = session.state !== "connected";
    if (session.state === "connected") terminal.focus();
  }, [session.state, session.terminalId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".ant-dropdown")) return;
      close();
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", closeOnClick);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("click", closeOnClick);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [contextMenu]);

  const menuItems: MenuProps["items"] = [
    { key: "copy", label: "复制选中", disabled: !contextMenu?.selectedText },
    { key: "copyAll", label: "复制全部" },
    { key: "paste", label: "粘贴", disabled: !connected },
    { type: "divider" },
    { key: "selectAll", label: "全选输出" },
    { key: "clear", label: "清空输出" },
  ];

  async function pasteToTerminal() {
    if (!connectedRef.current) return;
    const text = await readClipboardText();
    if (text) {
      sendDataRef.current(text);
    }
    terminalRef.current?.focus();
  }

  async function copySelection() {
    const text = terminalRef.current?.getSelection() ?? "";
    if (text) await writeClipboardText(text);
  }

  async function copyAll() {
    const terminal = terminalRef.current;
    if (!terminal) return;
    await writeClipboardText(terminalBufferText(terminal));
  }

  function selectAll() {
    terminalRef.current?.selectAll();
    terminalRef.current?.focus();
  }

  function clearTerminal() {
    terminalRef.current?.clear();
    clearRef.current();
    terminalRef.current?.focus();
  }

  async function handleMenuClick(key: string) {
    setContextMenu(null);
    if (key === "copy") await copySelection();
    else if (key === "copyAll") await copyAll();
    else if (key === "paste") await pasteToTerminal();
    else if (key === "selectAll") selectAll();
    else if (key === "clear") clearTerminal();
  }

  function leaveCommandInput() {
    commandInputRef.current?.blur();
    terminalRef.current?.focus();
  }

  function submitCommandInput() {
    if (!connectedRef.current) return;
    const command = commandInputValue.trim();
    if (command) sendDataRef.current(`${command}\r`);
    setCommandInputValue("");
    requestSafeAnimationFrame(leaveCommandInput);
  }

  function handleCommandInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      submitCommandInput();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setCommandInputValue("");
      leaveCommandInput();
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && commandInputValue.length === 0) {
      event.preventDefault();
      if (connectedRef.current) {
        sendDataRef.current(event.key === "ArrowUp" ? "\x1b[A" : "\x1b[B");
      }
      leaveCommandInput();
    }
  }

  return (
    <section className="terminalPanel">
      <div
        className="terminalOutput"
        onClick={() => {
          setContextMenu(null);
          terminalRef.current?.focus();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            selectedText: terminalRef.current?.getSelection() ?? "",
          });
        }}
      >
        <div ref={terminalHostRef} className="terminalHost" />
        <Dropdown
          open={Boolean(contextMenu)}
          trigger={[]}
          menu={{ items: menuItems, onClick: ({ key }) => void handleMenuClick(String(key)) }}
          onOpenChange={(open) => {
            if (!open) setContextMenu(null);
          }}
        >
          <span className="terminalContextMenuAnchor" style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }} />
        </Dropdown>
      </div>
      <div className="terminalToolbar">
        <input
          ref={commandInputRef}
          className="terminalToolbarInput"
          type="text"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={connected ? "输入命令，回车发送" : "未连接"}
          disabled={!connected}
          value={commandInputValue}
          onChange={(event) => setCommandInputValue(event.currentTarget.value)}
          onKeyDown={handleCommandInputKeyDown}
        />
      </div>
    </section>
  );
}

function writeTerminalEntry(terminal: XtermTerminal, entry: TerminalEntry) {
  writeTerminalData(terminal, terminalEntryData(entry));
}

function writeTerminalData(terminal: XtermTerminal, content: TerminalWriteData) {
  const shouldStickToBottom = isTerminalAtBottom(terminal) || shouldFollowTerminalOutput(content);
  terminal.write(content, () => {
    terminal.refresh(0, terminal.rows - 1);
    if (shouldStickToBottom) terminal.scrollToBottom();
  });
}

type TerminalWriteData = string | Uint8Array;

function terminalEntryData(entry: TerminalEntry): TerminalWriteData {
  if (entry.dataBase64) return decodeBase64Bytes(entry.dataBase64);
  if (entry.kind === "system") {
    if (entry.content === "连接已断开") {
      return `\r\n\x1b[31m${entry.timestamp} ${entry.content}\x1b[0m\r\n`;
    }
    return `\r\n${entry.timestamp} ${entry.content}\r\n`;
  }
  if (entry.kind === "input") {
    return `${entry.content}\r\n`;
  }
  if (entry.kind === "error" && !hasTerminalControl(entry.content)) {
    return `${entry.content}\r\n`;
  }
  return entry.content;
}

function decodeBase64Bytes(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function terminalEntryDataLength(value: TerminalWriteData) {
  return typeof value === "string" ? value.length : value.length;
}

function sliceTerminalEntryData(value: TerminalWriteData, start: number): TerminalWriteData {
  return typeof value === "string" ? value.slice(start) : value.slice(start);
}

function isTerminalAtBottom(terminal: XtermTerminal) {
  const buffer = terminal.buffer.active;
  return buffer.viewportY >= Math.max(0, buffer.baseY - 1);
}

function shouldFollowTerminalOutput(value: TerminalWriteData) {
  const text = terminalWriteDataText(value);
  return hasFullScreenTerminalControl(text) || hasInteractiveTerminalMarker(text) || /\r(?!\n)/.test(text);
}

function terminalWriteDataText(value: TerminalWriteData) {
  if (typeof value === "string") return value;
  try {
    return new TextDecoder().decode(value);
  } catch (error) {
    console.debug("[helm] failed to decode terminal write data:", error);
    return "";
  }
}

function hasAlternateScreenEnter(text: string) {
  return /\x1b\[\?(?:47|1047|1049)h/.test(text);
}

function hasFullScreenTerminalControl(text: string) {
  return hasAlternateScreenEnter(text) || /\x1b\[\d+;\d+[Hf]/.test(text);
}

function hasInteractiveTerminalMarker(text: string) {
  return (
    /Package configuration|Configuring [^\r\n]+|<\s*(?:Ok|OK|Yes|No|Cancel|Back)\s*>/.test(text) ||
    /[┌┐└┘─│╭╮╰╯═║╔╗╚╝]/.test(text) ||
    /\x1b\(0/.test(text)
  );
}

function hasTerminalControl(content: string) {
  return /[\x1b\r\n]/.test(content);
}

function terminalBufferText(terminal: XtermTerminal) {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n").replace(/\s+$/g, "");
}
