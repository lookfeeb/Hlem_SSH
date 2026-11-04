import { Dropdown, message } from "antd";
import type { MenuProps } from "antd";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { memo, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { appApi } from "../api/appApi";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import { getErrorMessage } from "../lib/configMapping";
import { useAnimationFrameRegistry } from "../lib/reactLifecycle";
import { registerTerminalSink } from "../lib/terminalRegistry";
import { TerminalViewportFollower } from "../lib/terminalViewportFollow";
import { TerminalInputHighlight } from "../lib/terminalInputHighlight";
import { TerminalRenderer } from "../lib/terminalRenderer";
import { extractPromptCwd } from "../app/appHelpers";
import { recordPerformance } from "../lib/performanceMetrics";
import type { RemoteSession, TerminalEntry } from "../types";

interface TerminalPanelProps {
  session: RemoteSession;
  active: boolean;
  scrollback: number;
  webglEnabled: boolean;
  onSendData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onClear: () => void;
  onCwd: (cwd: string) => void;
}

type AppliedTerminalState = {
  sessionKey: string;
  offsets: Map<string, number>;
};

function TerminalPanelView({ session, active, scrollback, webglEnabled, onSendData, onResize, onClear, onCwd }: TerminalPanelProps) {
  const [contextMenu, setContextMenu] = useState<{ selectedText: string } | null>(null);
  const [commandInputValue, setCommandInputValue] = useState("");
  const requestSafeAnimationFrame = useAnimationFrameRegistry();
  const commandInputRef = useRef<HTMLInputElement>(null);
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const viewportFollowerRef = useRef<TerminalViewportFollower | null>(null);
  const rendererRef = useRef<TerminalRenderer | null>(null);
  const inputHighlightRef = useRef<TerminalInputHighlight | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const appliedRef = useRef<AppliedTerminalState | null>(null);
  const layoutScheduledRef = useRef(false);
  const refreshAfterLayoutRef = useRef(false);
  const focusAfterLayoutRef = useRef(false);
  const lastSizeRef = useRef<{ terminalId: string | null; cols: number; rows: number }>({ terminalId: null, cols: 0, rows: 0 });
  const terminalIdRef = useRef<string | null>(session.terminalId ?? null);
  const activeRef = useRef(active);
  const sendDataRef = useRef(onSendData);
  const resizeRef = useRef(onResize);
  const clearRef = useRef(onClear);
  const cwdContextRef = useRef({ username: session.username, loginPath: session.loginPath, onCwd });
  cwdContextRef.current = { username: session.username, loginPath: session.loginPath, onCwd };
  const inputStartedRef = useRef<number | null>(null);
  const pendingConsumptionRef = useRef(new Set<() => void>());
  const terminalAvailable = session.state === "connected" && Boolean(session.terminalId);
  const terminalAvailableRef = useRef(terminalAvailable);

  terminalIdRef.current = session.terminalId ?? null;
  activeRef.current = active;
  terminalAvailableRef.current = terminalAvailable;

  useEffect(() => {
    sendDataRef.current = onSendData;
  }, [onSendData]);

  useEffect(() => {
    resizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    clearRef.current = onClear;
  }, [onClear]);

  function fitAndResizeTerminal() {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const host = terminalHostRef.current;
    if (!terminal || !fitAddon || !host || !activeRef.current) return;
    if (host.clientWidth <= 1 || host.clientHeight <= 1) return;
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

  function scheduleTerminalLayout(options: { refresh?: boolean; focus?: boolean } = {}) {
    refreshAfterLayoutRef.current ||= options.refresh ?? false;
    focusAfterLayoutRef.current ||= options.focus ?? false;
    if (layoutScheduledRef.current) return;
    layoutScheduledRef.current = true;
    requestSafeAnimationFrame(() => {
      layoutScheduledRef.current = false;
      const shouldRefresh = refreshAfterLayoutRef.current;
      const shouldFocus = focusAfterLayoutRef.current;
      refreshAfterLayoutRef.current = false;
      focusAfterLayoutRef.current = false;
      if (!activeRef.current) return;
      fitAndResizeTerminal();
      const terminal = terminalRef.current;
      if (!terminal) return;
      if (shouldRefresh && terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
      viewportFollowerRef.current?.handleLayoutComplete(terminalIdRef.current);
      if (shouldFocus && terminalAvailableRef.current) terminal.focus();
    });
  }

  function prepareTerminalForInput() {
    inputStartedRef.current = performance.now();
    viewportFollowerRef.current?.detach(terminalIdRef.current);
    terminalRef.current?.scrollToBottom();
  }

  function writeOutputToTerminal(terminal: XtermTerminal, content: TerminalWriteData, onConsumed?: () => void, bareCarriageReturn?: boolean) {
    const terminalId = terminalIdRef.current;
    const received = performance.now();
    const consume = () => {
      if (pendingConsumptionRef.current.delete(consume)) onConsumed?.();
    };
    if (onConsumed) pendingConsumptionRef.current.add(consume);
    writeTerminalData(terminal, content, {
      bareCarriageReturn,
      shouldForceFollow: () => viewportFollowerRef.current?.shouldFollow(terminalId) ?? false,
      onWriteComplete: () => {
        consume();
        recordPerformance("terminal:parse", received);
        if (inputStartedRef.current !== null) {
          recordPerformance("terminal:input-to-next-output", inputStartedRef.current);
          inputStartedRef.current = null;
        }
        viewportFollowerRef.current?.handleWriteComplete(terminalId);
      },
    });
  }

  function detachViewportFollow() {
    viewportFollowerRef.current?.detach(terminalIdRef.current);
  }

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    const terminal = new XtermTerminal({
      allowProposedApi: true,
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      disableStdin: !activeRef.current || !terminalAvailableRef.current,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      scrollback,
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
      void appApi.openExternalUrl(url).catch((error) => {
        console.warn("[helm] failed to open terminal link:", getErrorMessage(error));
      });
    }));
    terminal.open(host);
    const renderer = new TerminalRenderer(terminal);
    rendererRef.current = renderer;
    const inputHighlight = new TerminalInputHighlight(terminal);
    inputHighlightRef.current = inputHighlight;
    const eraseScreen = terminal.parser.registerCsiHandler({ final: "J" }, () => { inputHighlight.clear(); return false; });
    const resetScreen = terminal.parser.registerEscHandler({ final: "c" }, () => { inputHighlight.clear(); return false; });
    const cwdMarker = terminal.parser.registerOscHandler(777, (data) => {
      if (!data.startsWith("cwd=")) return false;
      cwdContextRef.current.onCwd(data.slice(4));
      return true;
    });
    let readbackTimer: ReturnType<typeof setTimeout> | undefined;
    let lastReadback = -Infinity;
    let lastCwd = "";
    const readback = () => {
      readbackTimer = undefined;
      lastReadback = performance.now();
      if (terminal.buffer.active.type === "alternate") return;
      const context = cwdContextRef.current;
      const tail = terminalPromptTail(terminal);
      if (!isTerminalAtBottom(terminal) && hasInteractiveTerminalMarker(tail)) terminal.scrollToBottom();
      const cwd = extractPromptCwd(tail, context.username, context.loginPath);
      if (cwd && cwd !== lastCwd) { lastCwd = cwd; context.onCwd(cwd); }
    };
    const parsed = terminal.onWriteParsed(() => {
      inputHighlight.parsed();
      // Read the decoded screen at most 20 Hz (5 Hz in background), once for
      // both prompt detection and viewport heuristics, never per byte chunk.
      const remaining = (activeRef.current ? 50 : 200) - (performance.now() - lastReadback);
      if (remaining <= 0) {
        if (readbackTimer !== undefined) clearTimeout(readbackTimer);
        readback();
      } else if (readbackTimer === undefined) readbackTimer = setTimeout(readback, remaining);
    });
    const viewportFollower = new TerminalViewportFollower(
      () => terminalRef.current?.scrollToBottom(),
      {
        setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clearTimeout: (handle) => window.clearTimeout(handle),
        requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
        cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
      },
    );
    viewportFollowerRef.current = viewportFollower;
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if (key === "pageup" || key === "pagedown" || key === "home" || key === "end") {
        detachViewportFollow();
      }
      if (event.ctrlKey && event.shiftKey && key === "c") {
        event.preventDefault();
        void copySelection();
        return false;
      }
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
      if (!activeRef.current || !terminalAvailableRef.current) return;
      inputHighlight.input(data, pendingConsumptionRef.current.size === 0);
      prepareTerminalForInput();
      sendDataRef.current(data);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const handleViewportWheel = () => detachViewportFollow();
    const handleViewportPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".xterm-scrollable-element > .scrollbar")) {
        detachViewportFollow();
      }
    };
    host.addEventListener("wheel", handleViewportWheel, { passive: true });
    host.addEventListener("pointerdown", handleViewportPointerDown);

    const resizeObserver = new ResizeObserver(() => scheduleTerminalLayout({ refresh: true }));
    resizeObserver.observe(host);
    scheduleTerminalLayout({ refresh: true, focus: activeRef.current });

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      cwdMarker.dispose();
      parsed.dispose();
      if (readbackTimer !== undefined) clearTimeout(readbackTimer);
      inputHighlight.clear();
      eraseScreen.dispose();
      resetScreen.dispose();
      inputHighlightRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
      host.removeEventListener("wheel", handleViewportWheel);
      host.removeEventListener("pointerdown", handleViewportPointerDown);
      viewportFollower.dispose();
      // The replay registry owns these bytes after the renderer goes away.
      // Release its outstanding credit even if xterm drops queued callbacks.
      for (const consume of pendingConsumptionRef.current) consume();
      terminal.dispose();
      terminalRef.current = null;
      viewportFollowerRef.current = null;
      fitAddonRef.current = null;
      appliedRef.current = null;
      layoutScheduledRef.current = false;
      refreshAfterLayoutRef.current = false;
      focusAfterLayoutRef.current = false;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.scrollback = Math.max(500, Math.min(50_000, scrollback));
  }, [scrollback]);

  useEffect(() => {
    rendererRef.current?.update(webglEnabled, active);
  }, [webglEnabled, active]);

  useEffect(() => {
    if (!active) {
      setContextMenu(null);
      return;
    }
    scheduleTerminalLayout({ refresh: true, focus: terminalAvailable });
  }, [active, session.terminalId, terminalAvailable]);

  useEffect(() => {
    viewportFollowerRef.current?.attach(session.terminalId ?? null);
  }, [session.terminalId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const sessionKey = session.id;
    if (appliedRef.current?.sessionKey !== sessionKey) {
      inputHighlightRef.current?.clear();
      terminal.reset();
      appliedRef.current = { sessionKey, offsets: new Map() };
    }

    const applied = appliedRef.current;
    if (!applied) return;

    if (session.terminal.length === 0 && applied.offsets.size > 0) {
      inputHighlightRef.current?.clear();
      terminal.clear();
      applied.offsets.clear();
      return;
    }

    for (const entry of session.terminal) {
      const content = terminalEntryData(entry);
      const contentLength = content.length;
      const previousLength = applied.offsets.get(entry.id) ?? 0;
      if (previousLength < contentLength) {
        const nextContent = sliceTerminalEntryData(content, previousLength);
        writeOutputToTerminal(terminal, nextContent);
        applied.offsets.set(entry.id, contentLength);
      }
    }
  }, [session.id, session.terminalId, session.terminal]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !session.terminalId) return;
    return registerTerminalSink(session.terminalId, {
      writeEntry: (entry, onConsumed) => writeOutputToTerminal(terminal, terminalEntryData(entry), onConsumed, entry.hasBareCarriageReturn),
      clear: () => { inputHighlightRef.current?.clear(); terminal.clear(); },
      reset: () => { inputHighlightRef.current?.clear(); terminal.reset(); },
    });
  }, [session.terminalId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = !active || !terminalAvailable;
  }, [active, terminalAvailable]);

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
    { key: "paste", label: "粘贴", disabled: !terminalAvailable },
    { type: "divider" },
    { key: "selectAll", label: "全选输出" },
    { key: "clear", label: "清空输出" },
  ];

  async function pasteToTerminal() {
    if (!activeRef.current || !terminalAvailableRef.current) return;
    const terminal = terminalRef.current;
    const terminalId = terminalIdRef.current;
    try {
      const text = await readClipboardText();
      if (
        !activeRef.current || !terminalAvailableRef.current ||
        terminalRef.current !== terminal || terminalIdRef.current !== terminalId
      ) return;
      // Use xterm's paste handling for newline normalization and bracketed paste.
      if (text) terminal?.paste(text);
    } catch (error) {
      message.error(`粘贴失败：${getErrorMessage(error)}`);
    } finally {
      if (activeRef.current && terminalRef.current === terminal) terminal?.focus();
    }
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
    if (!activeRef.current || !terminalAvailableRef.current) return;
    const command = commandInputValue.trim();
    if (command) {
      terminalRef.current?.input(`${command}\r`, true);
    }
    setCommandInputValue("");
    requestSafeAnimationFrame(leaveCommandInput);
  }

  function handleCommandInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
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
      if (activeRef.current && terminalAvailableRef.current) {
        terminalRef.current?.input(event.key === "ArrowUp" ? "\x1b[A" : "\x1b[B", true);
      }
      leaveCommandInput();
    }
  }

  return (
    <section className="terminalPanel">
      <Dropdown
        open={Boolean(contextMenu)}
        trigger={["contextMenu"]}
        menu={{ items: menuItems, onClick: ({ key }) => void handleMenuClick(String(key)) }}
        onOpenChange={(open) => {
          if (!open) setContextMenu(null);
        }}
      >
        <div
          className="terminalOutput"
          onClick={() => {
            setContextMenu(null);
            if (activeRef.current) terminalRef.current?.focus();
          }}
          onContextMenu={() => {
            setContextMenu({ selectedText: terminalRef.current?.getSelection() ?? "" });
          }}
        >
          <div ref={terminalHostRef} className="terminalHost" />
          {session.connectionNotice && (
            <div
              className={`terminalConnectionNotice terminalConnectionNotice-${session.state}`}
              role="status"
            >
              {session.connectionNotice}
            </div>
          )}
        </div>
      </Dropdown>
      <div className="terminalToolbar">
        <span className="terminalColorLegend" aria-label="蓝色为用户输入，服务器输出保留原有配色"><span>用户输入</span><span>服务器输出</span></span>
        <input
          ref={commandInputRef}
          className="terminalToolbarInput"
          type="text"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={terminalAvailable ? "输入命令，回车发送" : session.state === "connected" ? "终端已关闭" : "未连接"}
          disabled={!active || !terminalAvailable}
          value={commandInputValue}
          onChange={(event) => setCommandInputValue(event.currentTarget.value)}
          onKeyDown={handleCommandInputKeyDown}
        />
      </div>
    </section>
  );
}

export const TerminalPanel = memo(TerminalPanelView, (previous, next) => (
  previous.active === next.active &&
  previous.scrollback === next.scrollback &&
  previous.webglEnabled === next.webglEnabled &&
  previous.session.id === next.session.id &&
  previous.session.state === next.session.state &&
  previous.session.terminalId === next.session.terminalId &&
  previous.session.username === next.session.username &&
  previous.session.loginPath === next.session.loginPath &&
  previous.session.connectionNotice === next.session.connectionNotice &&
  previous.session.terminal === next.session.terminal
));

type TerminalWriteOptions = {
  bareCarriageReturn?: boolean;
  shouldForceFollow?: () => boolean;
  onWriteComplete?: () => void;
};

function writeTerminalData(terminal: XtermTerminal, content: TerminalWriteData, options: TerminalWriteOptions = {}) {
  const shouldStickToBottom = isTerminalAtBottom(terminal) || (options.bareCarriageReturn ?? hasBareCarriageReturn(content));
  terminal.write(content, () => {
    if (shouldStickToBottom || terminal.buffer.active.type === "alternate" || options.shouldForceFollow?.()) terminal.scrollToBottom();
    options.onWriteComplete?.();
  });
}

type TerminalWriteData = string | Uint8Array;

function terminalEntryData(entry: TerminalEntry): TerminalWriteData {
  if (entry.dataBytes) return entry.dataBytes;
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

function sliceTerminalEntryData(value: TerminalWriteData, start: number): TerminalWriteData {
  return typeof value === "string" ? value.slice(start) : value.subarray(start);
}

function isTerminalAtBottom(terminal: XtermTerminal) {
  const buffer = terminal.buffer.active;
  return buffer.viewportY >= Math.max(0, buffer.baseY - 1);
}

function terminalPromptTail(terminal: XtermTerminal) {
  const buffer = terminal.buffer.active;
  const end = buffer.baseY + buffer.cursorY;
  const lines: string[] = [];
  // Reuse xterm's decoded screen. Work is bounded regardless of output size.
  for (let index = Math.max(0, end - 7); index <= end; index++) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n").slice(-8192);
}

function hasBareCarriageReturn(value: TerminalWriteData) {
  if (typeof value === "string") return /\r(?!\n)/.test(value);
  for (let index = value.indexOf(13); index !== -1; index = value.indexOf(13, index + 1)) {
    if (value[index + 1] !== 10) return true;
  }
  return false;
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
