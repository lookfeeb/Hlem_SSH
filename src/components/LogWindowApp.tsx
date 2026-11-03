import "../styles/modals/modal-logs.css";
import { CheckOutlined, CopyOutlined, FilterOutlined, ReloadOutlined, RightOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, ConfigProvider, Empty, Input, Pagination, Popover, Select, Spin, Tooltip, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appApi, type ApiLogEntry } from "../api/appApi";
import { appEvents } from "../api/appEvents";
import { writeClipboardText } from "../lib/clipboard";
import { getErrorMessage } from "../lib/configMapping";
import { apiLogEntryKey, filterApiLogEntries, mergeApiLogEntries, type ApiLogStatusFilter } from "../lib/apiLogEntries";
import { formatBeijingMonthDayTime } from "../lib/format";
import { useMountedRef, useTimeoutRegistry } from "../lib/reactLifecycle";
import { ApiLogDetailModal, ApiLogStatus, ApiLogTypeBadge, formatApiLogDetail } from "./logs/ApiLogDetailModal";

const PAGE_SIZE = 10;

export function LogWindowApp() {
  const [logs, setLogs] = useState<ApiLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [selectedLog, setSelectedLog] = useState<ApiLogEntry | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ApiLogStatusFilter>("all");
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const mountedRef = useMountedRef();
  const loadingRef = useRef(false);
  const setSafeTimeout = useTimeoutRegistry();

  const loadLogs = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const items = await appApi.apiServerLogs();
      if (mountedRef.current) {
        setLogs((current) => mergeApiLogEntries(current, items));
        setError(null);
      }
    } catch (failure) {
      if (mountedRef.current) setError(getErrorMessage(failure));
    } finally {
      loadingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [mountedRef]);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;
    let pollingTimer: number | null = null;
    void appEvents.onApiLog((entry) => {
      if (mounted) setLogs((current) => mergeApiLogEntries(current, [entry]));
    }).then((unsubscribe) => {
      if (!mounted) { unsubscribe(); return; }
      unlisten = unsubscribe;
      setLive(true);
      // Merge after subscribing so events arriving during the snapshot are preserved.
      void loadLogs();
    }).catch((failure) => {
      console.warn("[helm] failed to subscribe api logs:", getErrorMessage(failure));
      if (mounted) {
        void loadLogs();
        pollingTimer = window.setInterval(() => void loadLogs(), 3000);
      }
    });
    return () => {
      mounted = false;
      unlisten?.();
      if (pollingTimer !== null) clearInterval(pollingTimer);
    };
  }, [loadLogs]);

  const actions = useMemo(() => [...new Set(logs.map((log) => log.action))].sort(), [logs]);
  const filtered = useMemo(() => filterApiLogEntries(logs, query, status, action).reverse(), [logs, query, status, action]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const filterCount = Number(status !== "all") + Number(Boolean(action));
  const hasFilters = Boolean(query.trim()) || filterCount > 0;
  const selectedKey = selectedLog ? apiLogEntryKey(selectedLog) : null;

  function resetFilters() {
    setQuery(""); setStatus("all"); setAction(""); setPage(1);
  }

  async function copyLogs() {
    if (!filtered.length) return;
    const success = await writeClipboardText(filtered.map(formatApiLogDetail).join("\n\n"));
    if (!mountedRef.current) return;
    setCopied(success);
    setCopyError(!success);
    setSafeTimeout(() => { setCopied(false); setCopyError(false); }, 2000);
  }

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: "#3973f6", borderRadius: 8, fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' } }}>
      <main className="logWindow">
        <header className="logWindowHeader">
          <div className="logWindowHeading">
            <h1>操作日志</h1>
            <p>查看 AI API 请求与响应</p>
          </div>
          <div className="logWindowTools">
            <Input className="logWindowSearch" aria-label="搜索操作日志" prefix={<SearchOutlined />} placeholder="搜索命令、状态或响应内容…" allowClear value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
            <Popover trigger="click" placement="bottomRight" rootClassName="logFilterPopover" content={(
              <div className="logFilterForm">
                <div className="logFilterHeading"><strong>筛选日志</strong><Button type="link" size="small" onClick={() => { setStatus("all"); setAction(""); setPage(1); }}>重置</Button></div>
                <label htmlFor="logStatusFilter">状态</label>
                <Select id="logStatusFilter" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={[{ value: "all", label: "全部状态" }, { value: "success", label: "成功" }, { value: "error", label: "失败" }]} />
                <label htmlFor="logActionFilter">类型</label>
                <Select id="logActionFilter" value={action} onChange={(value) => { setAction(value); setPage(1); }} options={[{ value: "", label: "全部类型" }, ...[...new Set([...actions, ...(action ? [action] : [])])].map((value) => ({ value, label: value.toUpperCase() }))]} />
              </div>
            )}>
              <Button className={filterCount ? "logFilterButton is-active" : "logFilterButton"} icon={<FilterOutlined />}>筛选{filterCount > 0 ? ` · ${filterCount}` : ""}</Button>
            </Popover>
            <span className="logWindowCount">{logs.length} 条记录</span>
            <Tooltip title="刷新日志"><Button type="text" aria-label="刷新日志" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadLogs()} /></Tooltip>
            <Tooltip title={copyError ? "复制失败，请重试" : copied ? "已复制" : "复制当前筛选的全部日志"}><Button type="text" aria-label="复制日志" className={copied ? "is-copied" : ""} icon={copied ? <CheckOutlined /> : <CopyOutlined />} disabled={!filtered.length} onClick={() => void copyLogs()} /></Tooltip>
          </div>
        </header>
        {error && <Alert className="logWindowError" type="error" showIcon title="读取日志失败" description={error} action={<Button size="small" onClick={() => void loadLogs()}>重试</Button>} />}
        {copyError && <span className="logWindowCopyError" role="alert">复制失败，请重试</span>}
        <section className="logWindowTableCard" aria-label="操作日志列表" aria-busy={loading}>
          <div className="logWindowTableScroll" key={`${currentPage}:${query}:${status}:${action}`}>
            <table className="logWindowTable">
              <colgroup><col className="logColExpand" /><col className="logColTime" /><col className="logColType" /><col /><col className="logColStatus" /><col className="logColDuration" /></colgroup>
              <thead><tr><th aria-label="详情" /><th scope="col">时间</th><th scope="col">类型</th><th scope="col">命令 / 操作</th><th scope="col">状态</th><th scope="col">耗时</th></tr></thead>
              <tbody>
                {visible.map((log) => {
                  const key = apiLogEntryKey(log);
                  return (
                    <tr key={key} className={selectedKey === key ? "is-selected" : ""} onClick={() => setSelectedLog(log)}>
                      <td><Button type="text" size="small" className="logOpenDetail" aria-label={`查看日志详情：${log.action} ${formatBeijingMonthDayTime(log.timestamp, log.timestamp, true)}`} aria-haspopup="dialog" icon={<RightOutlined />} onClick={(event) => { event.stopPropagation(); setSelectedLog(log); }} /></td>
                      <td className="logTimeCell">{formatBeijingMonthDayTime(log.timestamp, log.timestamp, true)}</td>
                      <td><ApiLogTypeBadge action={log.action} /></td>
                      <td><span className="logCommandPreview" title={log.detail}>{log.detail || "—"}</span></td>
                      <td><ApiLogStatus success={log.success} /></td>
                      <td className="logDurationCell">{log.durationMs}<span>ms</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!visible.length && <div className="logWindowEmpty">{loading ? <Spin description="正在加载日志"><div className="logLoadingSpace" /></Spin> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={hasFilters ? "没有匹配的日志" : "暂无操作日志"}>{hasFilters ? <Button onClick={resetFilters}>清除筛选</Button> : <span className="logEmptyHint">API 操作完成后，记录会自动显示在这里</span>}</Empty>}</div>}
          </div>
        </section>
        <footer className="logWindowFooter">
          <div className="logWindowSummary"><span>{hasFilters ? `匹配 ${filtered.length} / ${logs.length} 条记录` : `共 ${logs.length} 条记录`}</span><span className="logLiveStatus"><i className={live ? "is-live" : ""} />{live ? "实时更新" : "定时刷新"}</span></div>
          <Pagination current={currentPage} pageSize={PAGE_SIZE} total={filtered.length} showSizeChanger={false} showLessItems hideOnSinglePage={false} onChange={setPage} />
        </footer>
        <ApiLogDetailModal log={selectedLog} onClose={() => setSelectedLog(null)} />
      </main>
    </ConfigProvider>
  );
}
