import {
  CheckOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  CopyOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { Alert, Button, Input, Modal, Select, Spin, Tooltip, message } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { writeClipboardText } from "../../lib/clipboard";
import {
  applyDefaultSession,
  buildApiExplorerRequest,
  consumeApiSseChunk,
  createRequestDefaults,
  formatApiResponseForClipboard,
  formatApiResponseForDisplay,
  listOpenApiEndpoints,
  parseJsonRecord,
  parseJsonValue,
  stringifyRequestValue,
  type ApiExplorerEndpoint,
  type ApiExplorerRequestDefaults,
  type ApiSseEvent,
  type OpenApiDocument,
} from "../../lib/apiExplorer";
import { useTimeoutRegistry } from "../../lib/reactLifecycle";

type ApiExplorerModalProps = {
  open: boolean;
  onClose: () => void;
  baseUrl: string;
  apiKey: string;
  sessions: Array<{ id: string; name: string; host: string }>;
};

type ExplorerResponse = {
  status: number;
  statusText: string;
  durationMs: number;
  headers: string;
  body: string;
  format: "JSON" | "TEXT" | "BINARY" | "SSE";
  phase: "success" | "error" | "streaming" | "stopped";
  eventCount?: number;
};

type RequestEditorKind = "path" | "query" | "body";

const MAX_RESPONSE_TEXT = 1_000_000;

export function ApiExplorerModal({ open, onClose, baseUrl, apiKey, sessions }: ApiExplorerModalProps) {
  const [document, setDocument] = useState<OpenApiDocument | null>(null);
  const [selectedEndpointId, setSelectedEndpointId] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [pathText, setPathText] = useState("{}");
  const [queryText, setQueryText] = useState("{}");
  const [bodyText, setBodyText] = useState("");
  const [contentType, setContentType] = useState<string | null>(null);
  const [binaryBody, setBinaryBody] = useState(false);
  const [loadingSpec, setLoadingSpec] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [response, setResponse] = useState<ExplorerResponse | null>(null);
  const [copiedRequestField, setCopiedRequestField] = useState<RequestEditorKind | null>(null);
  const [responseCopied, setResponseCopied] = useState(false);
  const [lastJobId, setLastJobId] = useState("");
  const [endpointSearch, setEndpointSearch] = useState("");
  const streamControllerRef = useRef<AbortController | null>(null);
  const executeRequestRef = useRef<() => Promise<void>>(async () => undefined);
  const documentCacheRef = useRef<{
    cacheKey: string;
    etag: string;
    document: OpenApiDocument;
  } | null>(null);
  const setSafeTimeout = useTimeoutRegistry();

  const endpoints = useMemo(
    () => document ? listOpenApiEndpoints(document) : [],
    [document],
  );
  const selectedEndpoint = useMemo(
    () => endpoints.find((item) => item.id === selectedEndpointId) ?? null,
    [endpoints, selectedEndpointId],
  );
  const endpointGroups = useMemo(() => {
    const keyword = endpointSearch.trim().toLocaleLowerCase();
    const groups = new Map<string, ApiExplorerEndpoint[]>();
    for (const endpoint of endpoints) {
      const searchable = `${endpoint.method} ${endpoint.path} ${endpoint.category} ${endpoint.summary}`.toLocaleLowerCase();
      if (keyword && !searchable.includes(keyword)) continue;
      const items = groups.get(endpoint.category) ?? [];
      items.push(endpoint);
      groups.set(endpoint.category, items);
    }
    return [...groups.entries()].map(([category, items]) => ({ category, items }));
  }, [endpoints, endpointSearch]);
  const visibleEndpointCount = useMemo(
    () => endpointGroups.reduce((count, group) => count + group.items.length, 0),
    [endpointGroups],
  );
  const responseDisplay = useMemo(
    () => response ? formatApiResponseForDisplay(response.body) : null,
    [response],
  );

  useEffect(() => {
    if (!open) {
      streamControllerRef.current?.abort();
      streamControllerRef.current = null;
      setStreaming(false);
      return;
    }
    const nextSessionId = sessions.some((session) => session.id === selectedSessionId)
      ? selectedSessionId
      : sessions[0]?.id ?? "";
    setSelectedSessionId(nextSessionId);
    setLastJobId("");
    setEndpointSearch("");
    const controller = new AbortController();
    void loadDocument(controller.signal, nextSessionId);
    return () => {
      controller.abort();
      streamControllerRef.current?.abort();
    };
  }, [open, baseUrl, apiKey]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const requestEditor = target?.closest(".apiExplorerEditorViewport");
      if (requestEditor) {
        if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return;
      } else {
        const interactiveTarget = target?.closest("button, input, textarea, select, [contenteditable='true'], [role='button'], [role='combobox']");
        if (interactiveTarget || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      }
      event.preventDefault();
      void executeRequestRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  async function loadDocument(
    signal?: AbortSignal,
    preferredSessionId = selectedSessionId,
    preserveWorkspace = false,
  ) {
    if (!baseUrl || !apiKey) return;
    setLoadingSpec(true);
    setLoadError("");
    try {
      const cacheKey = `${baseUrl}\0${apiKey}`;
      const cached = documentCacheRef.current?.cacheKey === cacheKey
        ? documentCacheRef.current
        : null;
      const requestHeaders: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
      };
      if (cached?.etag) requestHeaders["If-None-Match"] = cached.etag;
      const result = await fetch(`${baseUrl}/openapi.json`, {
        headers: requestHeaders,
        signal,
      });
      const notModified = result.status === 304 && cached !== null;
      let nextDocument: OpenApiDocument;
      if (notModified) {
        nextDocument = cached.document;
      } else {
        const text = await result.text();
        if (!result.ok) throw new Error(readApiError(text, result.status));
        nextDocument = JSON.parse(text) as OpenApiDocument;
        documentCacheRef.current = {
          cacheKey,
          etag: result.headers.get("etag") ?? "",
          document: nextDocument,
        };
      }
      const nextEndpoints = listOpenApiEndpoints(nextDocument);
      const preservedEndpoint = preserveWorkspace
        ? nextEndpoints.find((item) => item.id === selectedEndpointId)
        : undefined;
      const nextEndpoint = preservedEndpoint
        ?? nextEndpoints.find((item) => item.path === "/api/exec")
        ?? nextEndpoints[0];
      if (!nextEndpoint) throw new Error("OpenAPI 文档没有可调试端点");
      setDocument(nextDocument);
      setSelectedEndpointId(nextEndpoint.id);
      if (!preservedEndpoint) {
        loadEndpointDefaults(nextDocument, nextEndpoint, preferredSessionId);
      }
      if (preserveWorkspace) message.success(notModified ? "OpenAPI 文档未变化" : "OpenAPI 文档已更新");
    } catch (error) {
      if (signal?.aborted) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (preserveWorkspace && document) {
        message.error(`刷新失败：${errorMessage}`);
      } else {
        setDocument(null);
        setLoadError(errorMessage);
      }
    } finally {
      if (!signal?.aborted) setLoadingSpec(false);
    }
  }

  function loadEndpointDefaults(
    nextDocument: OpenApiDocument,
    endpoint: ApiExplorerEndpoint,
    sessionId = selectedSessionId,
  ) {
    stopSseSubscription(false);
    const defaults = createRequestDefaults(nextDocument, endpoint, sessionId);
    if (lastJobId && "job_id" in defaults.path) defaults.path.job_id = lastJobId;
    applyEditorDefaults(defaults);
    setResponse(null);
    setCopiedRequestField(null);
    setResponseCopied(false);
  }

  function applyEditorDefaults(defaults: ApiExplorerRequestDefaults) {
    setPathText(stringifyRequestValue(defaults.path) || "{}");
    setQueryText(stringifyRequestValue(defaults.query) || "{}");
    setBodyText(stringifyRequestValue(defaults.body));
    setContentType(defaults.contentType);
    setBinaryBody(defaults.binaryBody);
  }

  function changeEndpoint(endpointId: string) {
    setSelectedEndpointId(endpointId);
    if (!document) return;
    const endpoint = endpoints.find((item) => item.id === endpointId);
    if (endpoint) loadEndpointDefaults(document, endpoint);
  }

  function changeSession(sessionId: string) {
    setSelectedSessionId(sessionId);
    try {
      const defaults: ApiExplorerRequestDefaults = {
        path: parseJsonRecord(pathText, "路径参数"),
        query: parseJsonRecord(queryText, "查询参数"),
        body: binaryBody ? bodyText : parseJsonValue(bodyText, "请求体"),
        contentType,
        binaryBody,
      };
      applyEditorDefaults(applyDefaultSession(defaults, sessionId));
    } catch {
      // 保留用户尚未完成的 JSON，仅更新默认会话选择。
    }
  }

  function createPlan() {
    if (!selectedEndpoint) throw new Error("请选择接口");
    const path = parseJsonRecord(pathText, "路径参数");
    const query = parseJsonRecord(queryText, "查询参数");
    const body = binaryBody ? bodyText : parseJsonValue(bodyText, "请求体");
    return buildApiExplorerRequest(baseUrl, selectedEndpoint, path, query, body, contentType);
  }

  async function executeRequest() {
    if (!selectedEndpoint) return;
    if (selectedEndpoint.path.endsWith("/events")) {
      if (streaming) {
        stopSseSubscription();
      } else {
        await subscribeToSse();
      }
      return;
    }
    if (executing) return;
    setExecuting(true);
    setResponse(null);
    setResponseCopied(false);
    try {
      const plan = createPlan();
      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
      if (plan.contentType) headers["Content-Type"] = plan.contentType;
      const startedAt = performance.now();
      const result = await fetch(plan.url, {
        method: plan.method,
        headers,
        body: plan.method === "GET" || plan.body === null || plan.body === undefined
          ? undefined
          : plan.contentType === "application/json"
            ? JSON.stringify(plan.body)
            : String(plan.body),
      });
      const durationMs = Math.round(performance.now() - startedAt);
      const responseContentType = result.headers.get("content-type") ?? "";
      let body: string;
      let rawText = "";
      if (responseContentType.includes("json") || responseContentType.startsWith("text/")) {
        rawText = await result.text();
        body = prettyResponseText(rawText, responseContentType);
      } else {
        const bytes = await result.arrayBuffer();
        body = `二进制响应：${bytes.byteLength.toLocaleString()} 字节\nContent-Type: ${responseContentType || "未知"}`;
      }
      setResponse({
        status: result.status,
        statusText: result.statusText,
        durationMs,
        headers: [...result.headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\n"),
        body,
        format: responseFormat(responseContentType),
        phase: result.ok ? "success" : "error",
      });
      if (result.ok && responseContentType.includes("json") && rawText) {
        const jobId = readJobId(rawText);
        if (jobId) {
          setLastJobId(jobId);
          if (selectedEndpoint.path === "/api/jobs" && selectedEndpoint.method === "post") {
            message.success("任务已创建，后续任务接口会自动填入 job_id");
          }
        }
      }
    } catch (error) {
      setResponse({
        status: 0,
        statusText: "请求失败",
        durationMs: 0,
        headers: "",
        body: error instanceof Error ? error.message : String(error),
        format: "TEXT",
        phase: "error",
      });
    } finally {
      setExecuting(false);
    }
  }

  async function subscribeToSse() {
    stopSseSubscription(false);
    const controller = new AbortController();
    streamControllerRef.current = controller;
    setStreaming(true);
    setResponse(null);
    setResponseCopied(false);

    const startedAt = performance.now();
    let status = 0;
    let headers = "";
    let receivedEvents: ApiSseEvent[] = [];
    try {
      const plan = createPlan();
      const result = await fetch(plan.url, {
        method: plan.method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      status = result.status;
      headers = [...result.headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\n");
      const responseContentType = result.headers.get("content-type") ?? "";
      if (!result.ok) {
        const rawText = await result.text();
        setResponse({
          status,
          statusText: result.statusText,
          durationMs: Math.round(performance.now() - startedAt),
          headers,
          body: prettyResponseText(rawText, responseContentType),
          format: responseFormat(responseContentType),
          phase: "error",
        });
        return;
      }
      if (!result.body) throw new Error("当前环境无法读取 SSE 响应流");

      const baseResponse = {
        status,
        headers,
        format: "SSE" as const,
      };
      const publishEvents = (phase: ExplorerResponse["phase"], statusText: string) => {
        setResponse({
          ...baseResponse,
          statusText,
          durationMs: Math.round(performance.now() - startedAt),
          body: JSON.stringify(receivedEvents, null, 2),
          phase,
          eventCount: receivedEvents.length,
        });
      };

      publishEvents("streaming", "SSE 订阅中");
      const reader = result.body.getReader();
      const decoder = new TextDecoder();
      let parserBuffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = consumeApiSseChunk(parserBuffer, decoder.decode(value, { stream: true }));
        parserBuffer = parsed.buffer;
        if (parsed.events.length) {
          receivedEvents = [...receivedEvents, ...parsed.events];
          publishEvents("streaming", "SSE 订阅中");
        }
      }
      const finalChunk = consumeApiSseChunk(parserBuffer, decoder.decode(), true);
      if (finalChunk.events.length) receivedEvents = [...receivedEvents, ...finalChunk.events];
      publishEvents("success", "SSE 已结束");
    } catch (error) {
      if (controller.signal.aborted) return;
      const errorText = error instanceof Error ? error.message : String(error);
      receivedEvents = [...receivedEvents, { event: "clientError", data: { error: errorText } }];
      setResponse({
        status,
        statusText: status ? "SSE 连接中断" : "请求失败",
        durationMs: Math.round(performance.now() - startedAt),
        headers,
        body: JSON.stringify(receivedEvents, null, 2),
        format: "SSE",
        phase: "error",
        eventCount: receivedEvents.length,
      });
    } finally {
      if (streamControllerRef.current === controller) {
        streamControllerRef.current = null;
        setStreaming(false);
      }
    }
  }

  function stopSseSubscription(showFeedback = true) {
    const controller = streamControllerRef.current;
    if (!controller) return;
    streamControllerRef.current = null;
    controller.abort();
    setStreaming(false);
    setResponse((current) => current?.phase === "streaming"
      ? {
          ...current,
          statusText: "SSE 已停止",
          phase: "stopped",
        }
      : current);
    if (showFeedback) message.info("已停止 SSE 实时订阅");
  }

  async function copyRequestField(kind: RequestEditorKind, label: string, value: string) {
    try {
      const ok = await writeClipboardText(formatApiResponseForClipboard(value));
      if (!ok) throw new Error("剪贴板不可用");
      setCopiedRequestField(kind);
      setSafeTimeout(() => setCopiedRequestField((current) => current === kind ? null : current), 1600);
      message.success(`${label}已复制`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function copyResponse() {
    if (!response) return;
    try {
      const ok = await writeClipboardText(formatApiResponseForClipboard(response.body));
      if (!ok) throw new Error("剪贴板不可用");
      setResponseCopied(true);
      setSafeTimeout(() => setResponseCopied(false), 1600);
      message.success("响应结果已复制");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  const hasPathParameters = selectedEndpoint?.operation.parameters?.some((item) => item.in === "path") ?? false;
  const hasQueryParameters = selectedEndpoint?.operation.parameters?.some((item) => item.in === "query") ?? false;
  const isSseEndpoint = selectedEndpoint?.path.endsWith("/events") ?? false;
  executeRequestRef.current = executeRequest;

  function renderRequestCopyButton(kind: RequestEditorKind, label: string, value: string) {
    const isCopied = copiedRequestField === kind;
    return (
      <Tooltip title={isCopied ? "已复制" : `复制${label}`} placement="left">
        <Button
          className={`apiExplorerRequestCopy ${isCopied ? "is-copied" : ""}`}
          icon={isCopied ? <CheckOutlined /> : <CopyOutlined />}
          aria-label={isCopied ? `${label}已复制` : `复制${label}`}
          onClick={() => void copyRequestField(kind, label, value)}
        />
      </Tooltip>
    );
  }

  function closeStudio() {
    stopSseSubscription(false);
    onClose();
  }

  return (
    <Modal
      open={open}
      title={null}
      footer={null}
      width={1320}
      centered
      destroyOnHidden
      closable={false}
      className="apiExplorerModal"
      onCancel={closeStudio}
    >
      <div className="apiExplorerShell">
        <header className="apiExplorerTopbar">
          <div className="apiExplorerBrand">
            <span className="apiExplorerBrandIcon">
              <img src="./Helm_icon.svg" alt="" aria-hidden="true" />
            </span>
            <div>
              <strong>HelM API Studio</strong>
              <span>OpenAPI 驱动的本机接口工作台</span>
            </div>
          </div>
          <div className="apiExplorerTopbarMeta">
            <span className="apiExplorerConnection"><i />{baseUrl}</span>
            {document && <span className="apiExplorerSpecBadge">OpenAPI {document.openapi}</span>}
            <Tooltip title="重新读取 OpenAPI 文档（保留当前结果）">
              <Button
                className="apiExplorerTopbarButton apiExplorerReload"
                icon={<ReloadOutlined />}
                loading={loadingSpec}
                aria-label="重新读取 OpenAPI 文档"
                onClick={() => void loadDocument(undefined, selectedSessionId, true)}
              />
            </Tooltip>
            <Tooltip title="关闭 API Studio">
              <Button
                className="apiExplorerTopbarButton apiExplorerClose"
                icon={<CloseOutlined />}
                aria-label="关闭 API Studio"
                onClick={closeStudio}
              />
            </Tooltip>
          </div>
        </header>

        <div className="apiExplorerBody">
          {loadingSpec && !document ? (
            <div className="apiExplorerLoading"><Spin /><span>正在读取 OpenAPI 文档</span></div>
          ) : loadError ? (
            <Alert
              type="error"
              showIcon
              message="无法打开接口调试台"
              description={loadError}
              action={<Button size="small" onClick={() => void loadDocument()}>重试</Button>}
            />
          ) : document && selectedEndpoint ? (
            <div className="apiExplorerWorkbench">
              <aside className="apiExplorerNavigator">
                <div className="apiExplorerNavigatorHead">
                  <div>
                    <span>接口目录</span>
                    <strong>{visibleEndpointCount}<small> / {endpoints.length}</small></strong>
                  </div>
                  <Input
                    className="apiExplorerSearch"
                    value={endpointSearch}
                    prefix={<SearchOutlined />}
                    placeholder="搜索路径或功能"
                    allowClear
                    onChange={(event) => setEndpointSearch(event.target.value)}
                  />
                </div>

                <nav className="apiExplorerDirectory" aria-label="接口目录">
                  {endpointGroups.map((group) => (
                    <section className="apiExplorerEndpointGroup" key={group.category}>
                      <div className="apiExplorerEndpointGroupTitle">
                        <span>{group.category}</span>
                        <small>{group.items.length}</small>
                      </div>
                      {group.items.map((endpoint) => (
                        <button
                          type="button"
                          className={`apiExplorerEndpointItem ${endpoint.id === selectedEndpointId ? "is-active" : ""}`}
                          key={endpoint.id}
                          title={`${endpoint.method.toUpperCase()} ${endpoint.path} · ${endpoint.summary}`}
                          onClick={() => changeEndpoint(endpoint.id)}
                        >
                          <span className={`apiExplorerMethod is-${endpoint.method}`}>{endpoint.method.toUpperCase()}</span>
                          <span className="apiExplorerEndpointItemCopy">
                            <code>{endpoint.path}</code>
                            <small>{endpoint.summary}</small>
                          </span>
                        </button>
                      ))}
                    </section>
                  ))}
                  {visibleEndpointCount === 0 && (
                    <div className="apiExplorerNoEndpoints">
                      <SearchOutlined />
                      <span>没有匹配的接口</span>
                      <button type="button" onClick={() => setEndpointSearch("")}>清空搜索</button>
                    </div>
                  )}
                </nav>

                <div className="apiExplorerSessionContext">
                  <Select
                    value={selectedSessionId || undefined}
                    placeholder="不使用默认会话"
                    allowClear
                    options={sessions.map((session) => ({
                      label: `${session.name} · ${session.host}`,
                      value: session.id,
                    }))}
                    onChange={(value) => changeSession(value ?? "")}
                  />
                </div>
              </aside>

              <main className="apiExplorerComposer">
                <header className="apiExplorerEndpointHeader">
                  <div className="apiExplorerRoute">
                    <span className={`apiExplorerMethod is-${selectedEndpoint.method}`}>{selectedEndpoint.method.toUpperCase()}</span>
                    <code title={selectedEndpoint.path}>{selectedEndpoint.path}</code>
                  </div>
                  <h2 title={selectedEndpoint.summary}>{selectedEndpoint.summary}</h2>
                </header>

                <section className="apiExplorerRequestStage">
                  <div className="apiExplorerEditors">
                    {hasPathParameters && (
                      <div className="apiExplorerEditorBlock">
                        <span><strong>路径参数</strong></span>
                        <div className="apiExplorerEditorViewport">
                          {renderRequestCopyButton("path", "路径参数", pathText)}
                          <Input.TextArea aria-label="路径参数" value={pathText} rows={4} spellCheck={false} onChange={(event) => setPathText(event.target.value)} />
                        </div>
                      </div>
                    )}
                    {hasQueryParameters && (
                      <div className="apiExplorerEditorBlock">
                        <span><strong>查询参数</strong></span>
                        <div className="apiExplorerEditorViewport">
                          {renderRequestCopyButton("query", "查询参数", queryText)}
                          <Input.TextArea aria-label="查询参数" value={queryText} rows={5} spellCheck={false} onChange={(event) => setQueryText(event.target.value)} />
                        </div>
                      </div>
                    )}
                    {contentType && (
                      <div className="apiExplorerEditorBlock is-body">
                        <span>
                          <strong>{binaryBody ? "原始请求内容" : "请求体"}</strong>
                          <small>{contentType}</small>
                        </span>
                        <div className="apiExplorerEditorViewport">
                          {renderRequestCopyButton("body", binaryBody ? "原始请求内容" : "请求体", bodyText)}
                          <Input.TextArea
                            aria-label={binaryBody ? "原始请求内容" : "请求体"}
                            value={bodyText}
                            rows={12}
                            spellCheck={false}
                            onChange={(event) => setBodyText(event.target.value)}
                          />
                        </div>
                      </div>
                    )}
                    {!hasPathParameters && !hasQueryParameters && !contentType && (
                      <div className="apiExplorerEmptyRequest">
                        <CheckOutlined />
                        <strong>无需填写参数，可直接发送</strong>
                      </div>
                    )}
                  </div>
                </section>

                <footer className="apiExplorerRequestFooter">
                  <Button
                    className={`apiExplorerExecute ${streaming ? "is-streaming" : ""}`}
                    type="primary"
                    icon={streaming ? <StopOutlined /> : <PlayCircleOutlined />}
                    loading={!isSseEndpoint && executing}
                    aria-keyshortcuts="Enter Control+Enter"
                    title="Enter 执行；请求输入框内使用 Ctrl+Enter"
                    onClick={() => void executeRequest()}
                  >
                    {streaming ? "停止订阅" : isSseEndpoint ? "开始实时订阅" : "发送请求"}
                  </Button>
                </footer>
              </main>

              <section className="apiExplorerInspector">
                <header className="apiExplorerInspectorHeader">
                  <div className="apiExplorerInspectorTitle">
                    <span>RESPONSE</span>
                    <strong>响应检查器</strong>
                  </div>
                  <div className={`apiExplorerInspectorSummary ${response ? "has-response" : ""} ${streaming ? "is-streaming" : response ? `is-${response.phase}` : ""}`}>
                    <span className={`apiExplorerInspectorState ${streaming ? "is-streaming" : response ? `is-${response.phase}` : ""}`}>
                      <i />
                      {streaming ? "实时接收" : response ? response.phase === "error" ? "请求异常" : response.phase === "stopped" ? "已停止" : "已返回" : "等待请求"}
                    </span>
                    {response && (
                      <div className="apiExplorerResponseMetaBar" aria-label="响应概要">
                        <span className={`apiExplorerStatus is-${response.phase}`}>
                          {response.status || "ERR"} {response.statusText}
                        </span>
                        <span className="apiExplorerResponseMetric">
                          <ClockCircleOutlined />
                          <small>{response.phase === "streaming" ? "已持续" : "耗时"}</small>
                          <strong>{response.durationMs.toLocaleString()} ms</strong>
                        </span>
                        {response.format === "SSE" && (
                          <span className="apiExplorerResponseMetric">
                            <small>事件</small>
                            <strong>{response.eventCount ?? 0}</strong>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </header>

                {response && responseDisplay ? (
                  <div className="apiExplorerResponseContent">
                    <div className="apiExplorerResponseBlock" tabIndex={0} aria-label="响应结果输出框">
                      <div className="apiExplorerResponseBlockHead">
                        <span>
                          <strong>响应正文</strong>
                          <small className={`apiExplorerResponseFormat is-${response.format.toLocaleLowerCase()}`}>{response.format}</small>
                        </span>
                        <small>{responseDisplay.text.length.toLocaleString()} 字符</small>
                      </div>
                      <div className="apiExplorerResponseViewport">
                        <Tooltip title={responseCopied ? "已复制" : "复制结构化响应"} placement="left">
                          <Button
                            className={`apiExplorerResponseCopy ${responseCopied ? "is-copied" : ""}`}
                            icon={responseCopied ? <CheckOutlined /> : <CopyOutlined />}
                            aria-label={responseCopied ? "响应结果已复制" : "复制响应结果"}
                            onClick={() => void copyResponse()}
                          />
                        </Tooltip>
                        <pre><code>{responseDisplay.tokens.map((token, index) => (
                          <span className={`apiExplorerResponseToken is-${token.type}`} key={`${token.type}-${index}`}>{token.value}</span>
                        ))}</code></pre>
                      </div>
                    </div>
                    {response.headers && (
                      <details className="apiExplorerResponseHeaders">
                        <summary>响应头</summary>
                        <pre>{response.headers}</pre>
                      </details>
                    )}
                  </div>
                ) : (
                  <div className="apiExplorerResponsePlaceholder">
                    <span className="apiExplorerResponsePlaceholderIcon"><PlayCircleOutlined /></span>
                    <strong>等待发送请求</strong>
                    <span>状态、耗时、响应正文和响应头会集中显示在这里</span>
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function prettyResponseText(raw: string, contentType: string): string {
  const bounded = raw.length > MAX_RESPONSE_TEXT
    ? `${raw.slice(0, MAX_RESPONSE_TEXT)}\n\n……响应过长，已截断……`
    : raw;
  if (!contentType.includes("json")) return bounded;
  try {
    return JSON.stringify(JSON.parse(bounded), null, 2);
  } catch {
    return bounded;
  }
}

function responseFormat(contentType: string): ExplorerResponse["format"] {
  if (contentType.includes("event-stream")) return "SSE";
  if (contentType.includes("json")) return "JSON";
  if (contentType.startsWith("text/")) return "TEXT";
  return "BINARY";
}

function readApiError(text: string, status: number): string {
  try {
    const value = JSON.parse(text) as {
      error?: string;
      message?: string;
      code?: string;
      requestId?: string;
    };
    const messageText = value.message || value.error || `HTTP ${status}`;
    const code = value.code ? `[${value.code}] ` : "";
    const requestId = value.requestId ? ` · ${value.requestId}` : "";
    return `${code}${messageText}${requestId}`;
  } catch {
    return text || `HTTP ${status}`;
  }
}

function readJobId(text: string): string {
  try {
    const value = JSON.parse(text) as { jobId?: unknown };
    return typeof value.jobId === "string" ? value.jobId : "";
  } catch {
    return "";
  }
}
