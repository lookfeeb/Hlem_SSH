use std::sync::OnceLock;

use serde_json::Value;

static API_FIELD_CATALOG: OnceLock<Value> = OnceLock::new();

const API_FIELD_CATALOG_JSON: &str = r###"
{
  "version": 10,
  "title": "HelM AI API 字段库",
  "description": "本地 SSH/SFTP 网关，仅提供 HTTP REST。",
  "auth": {
    "type": "bearer",
    "header": "Authorization",
    "format": "Bearer <api_key>"
  },
  "contentType": "application/json",
  "endpoints": [
    {
      "category": "元信息",
      "method": "GET",
      "path": "/api/auth",
      "summary": "验证凭证并查看接口概览",
      "responseSchema": "AuthDirectory"
    },
    {
      "category": "元信息",
      "method": "GET",
      "path": "/api/fields",
      "summary": "读取完整 AI API 字段库",
      "headerSchema": "CacheValidationHeaders",
      "responseSchema": "ApiFieldCatalog",
      "cacheable": true
    },
    {
      "category": "元信息",
      "method": "GET",
      "path": "/openapi.json",
      "summary": "读取标准 OpenAPI 接口文档",
      "headerSchema": "CacheValidationHeaders",
      "cacheable": true
    },
    {
      "category": "会话",
      "method": "GET",
      "path": "/api/sessions",
      "summary": "查看授权会话与连接状态",
      "responseSchema": "SessionItem[]"
    },
    {
      "category": "会话",
      "method": "POST",
      "path": "/api/connect",
      "summary": "预热指定 SSH 会话连接",
      "bodySchema": "SessionIdBody",
      "responseSchema": "ConnectionInfo"
    },
    {
      "category": "会话",
      "method": "POST",
      "path": "/api/disconnect",
      "summary": "断开指定 SSH 会话",
      "bodySchema": "SessionIdBody",
      "responseSchema": "SuccessResponse"
    },
    {
      "category": "操作",
      "method": "POST",
      "path": "/api/exec",
      "summary": "在指定会话执行单条命令",
      "bodySchema": "ExecBody",
      "responseSchema": "ExecResult"
    },
    {
      "category": "操作",
      "method": "POST",
      "path": "/api/exec/batch",
      "summary": "批量执行多条命令",
      "bodySchema": "BatchExecBody",
      "responseSchema": "BatchExecResponse"
    },
    {
      "category": "长任务",
      "method": "POST",
      "path": "/api/jobs",
      "summary": "创建可实时追踪的命令任务",
      "bodySchema": "ExecJobBody",
      "responseSchema": "JobSnapshot",
      "successStatus": 202
    },
    {
      "category": "长任务",
      "method": "GET",
      "path": "/api/jobs",
      "summary": "查看授权会话的命令任务",
      "responseSchema": "JobSummary[]"
    },
    {
      "category": "长任务",
      "method": "GET",
      "path": "/api/jobs/{job_id}",
      "summary": "查看命令任务状态与输出",
      "pathSchema": "JobPath",
      "responseSchema": "JobSnapshot"
    },
    {
      "category": "长任务",
      "method": "GET",
      "path": "/api/jobs/{job_id}/events",
      "summary": "实时订阅命令任务输出",
      "pathSchema": "JobPath",
      "querySchema": "JobEventsQuery",
      "headerSchema": "JobEventsHeaders",
      "responseSchema": "JobEvent",
      "responseContentType": "text/event-stream"
    },
    {
      "category": "长任务",
      "method": "POST",
      "path": "/api/jobs/{job_id}/cancel",
      "summary": "取消排队或运行中的任务",
      "pathSchema": "JobPath",
      "responseSchema": "JobSnapshot"
    },
    {
      "category": "诊断",
      "method": "POST",
      "path": "/api/latency",
      "summary": "检测指定会话的网络延迟",
      "bodySchema": "LatencyBody",
      "responseSchema": "LatencyProbeResult"
    },
    {
      "category": "文件",
      "method": "GET",
      "path": "/api/files",
      "summary": "浏览远端目录与文件",
      "querySchema": "FilesQuery",
      "responseSchema": "FileEntry[]"
    },
    {
      "category": "文件",
      "method": "GET",
      "path": "/api/files/page",
      "summary": "分页浏览大型远端目录",
      "querySchema": "FilesPageQuery",
      "responseSchema": "FilesPageResponse"
    },
    {
      "category": "文件",
      "method": "GET",
      "path": "/api/files/stat",
      "summary": "读取单个远端路径元数据",
      "querySchema": "FilesQuery",
      "responseSchema": "FileEntry"
    },
    {
      "category": "文件",
      "method": "PUT",
      "path": "/api/upload",
      "summary": "原子上传完整远端文件",
      "querySchema": "UploadQuery",
      "bodyRaw": "完整文件原始字节流，Content-Type 为 application/octet-stream，最大 512 MiB，不支持 Content-Range",
      "responseSchema": "UploadResponse"
    },
    {
      "category": "文件",
      "method": "GET",
      "path": "/api/download",
      "summary": "下载远端文件或字节范围",
      "querySchema": "DownloadQuery",
      "headerSchema": "DownloadHeaders",
      "responseSchema": "binary"
    },
    {
      "category": "隧道",
      "method": "GET",
      "path": "/api/tunnels",
      "summary": "查看 SSH 隧道配置",
      "responseSchema": "TunnelConfig[]"
    },
    {
      "category": "隧道",
      "method": "POST",
      "path": "/api/tunnels",
      "summary": "创建 SSH 隧道配置",
      "bodySchema": "TunnelInput",
      "responseSchema": "TunnelConfig[]"
    },
    {
      "category": "隧道",
      "method": "PATCH",
      "path": "/api/tunnels/{id}",
      "summary": "局部更新 SSH 隧道配置",
      "pathSchema": "TunnelPath",
      "bodySchema": "TunnelPatch",
      "responseSchema": "TunnelConfig[]"
    },
    {
      "category": "隧道",
      "method": "DELETE",
      "path": "/api/tunnels/{id}",
      "summary": "删除 SSH 隧道配置",
      "pathSchema": "TunnelPath",
      "responseSchema": "TunnelConfig[]"
    },
    {
      "category": "隧道",
      "method": "POST",
      "path": "/api/tunnels/{id}/start",
      "summary": "启动指定 SSH 隧道",
      "pathSchema": "TunnelPath",
      "responseSchema": "TunnelStartResponse"
    },
    {
      "category": "隧道",
      "method": "POST",
      "path": "/api/tunnels/{id}/stop",
      "summary": "停止指定 SSH 隧道",
      "pathSchema": "TunnelPath",
      "responseSchema": "SuccessResponse"
    },
    {
      "category": "备份",
      "method": "GET",
      "path": "/api/backup/settings",
      "summary": "查看自动备份设置",
      "responseSchema": "BackupSettings"
    },
    {
      "category": "备份",
      "method": "PUT",
      "path": "/api/backup/settings",
      "summary": "完整更新自动备份设置",
      "bodySchema": "BackupSettings",
      "responseSchema": "BackupSettings"
    },
    {
      "category": "备份",
      "method": "PATCH",
      "path": "/api/backup/settings",
      "summary": "局部更新自动备份设置",
      "bodySchema": "BackupSettingsPatch",
      "responseSchema": "BackupSettings"
    },
    {
      "category": "备份",
      "method": "GET",
      "path": "/api/backup/records",
      "summary": "查看备份历史记录",
      "responseSchema": "BackupRecord[]"
    },
    {
      "category": "备份",
      "method": "POST",
      "path": "/api/backup/run",
      "summary": "立即创建一次备份",
      "responseSchema": "BackupRecord[]"
    },
    {
      "category": "备份",
      "method": "DELETE",
      "path": "/api/backup/records/{id}",
      "summary": "删除备份记录，可同时删除文件",
      "pathSchema": "BackupRecordPath",
      "querySchema": "DeleteBackupRecordQuery",
      "responseSchema": "BackupRecord[]"
    }
  ],
  "schemas": {
    "AuthDirectory": [
      { "name": "authenticated", "type": "boolean", "description": "鉴权是否通过" },
      { "name": "auth", "type": "string", "description": "鉴权头格式" },
      { "name": "fieldCatalogVersion", "type": "number", "description": "当前字段库版本" },
      { "name": "serverInstanceId", "type": "string", "description": "本次服务进程实例 ID；重启服务后变化" },
      { "name": "rest", "type": "object", "description": "由字段库端点列表生成的接口目录" }
    ],
    "ApiFieldCatalog": [
      { "name": "version", "type": "number", "description": "字段库版本" },
      { "name": "title", "type": "string", "description": "字段库标题" },
      { "name": "description", "type": "string", "description": "API 简述" },
      { "name": "auth", "type": "object", "description": "鉴权说明" },
      { "name": "contentType", "type": "string", "description": "JSON 请求默认 Content-Type" },
      { "name": "endpoints", "type": "EndpointField[]", "description": "端点字段列表" },
      { "name": "schemas", "type": "Record<string, Field[]>", "description": "可复用字段结构" },
      { "name": "selectionRules", "type": "SelectionRule[]", "description": "端点与字段选择规则" },
      { "name": "examples", "type": "Record<string, CallExample>", "description": "不重复鉴权头的结构化调用示例" },
      { "name": "rules", "type": "string[]", "description": "调用规则" }
    ],
    "EndpointField": [
      { "name": "category", "type": "string", "required": true, "description": "端点分类" },
      { "name": "method", "type": "GET | POST | PUT | PATCH | DELETE", "required": true, "description": "HTTP 方法" },
      { "name": "path", "type": "string", "required": true, "description": "请求路径" },
      { "name": "summary", "type": "string", "required": true, "description": "简短用途" },
      { "name": "pathSchema", "type": "string", "description": "路径参数结构名" },
      { "name": "querySchema", "type": "string", "description": "查询参数结构名" },
      { "name": "headerSchema", "type": "string", "description": "额外请求头结构名" },
      { "name": "bodySchema", "type": "string", "description": "JSON 请求体结构名" },
      { "name": "bodyRaw", "type": "string", "description": "非 JSON 请求体说明" },
      { "name": "responseSchema", "type": "string", "description": "成功响应结构名" },
      { "name": "responseContentType", "type": "string", "description": "非 JSON 响应类型" },
      { "name": "successStatus", "type": "number", "description": "成功状态码，默认 200", "default": 200 },
      { "name": "cacheable", "type": "boolean", "description": "是否支持 ETag 与 If-None-Match", "default": false }
    ],
    "Field": [
      { "name": "name", "type": "string", "required": true, "description": "字段名" },
      { "name": "type", "type": "string", "required": true, "description": "字段类型或枚举" },
      { "name": "required", "type": "boolean", "description": "请求中是否必填，默认 false", "default": false },
      { "name": "description", "type": "string", "description": "字段语义与约束" },
      { "name": "default", "type": "object | string | number | boolean | null", "description": "省略字段时的默认值" },
      { "name": "minimum", "type": "number", "description": "数值有效下限" },
      { "name": "maximum", "type": "number", "description": "数值有效上限" },
      { "name": "example", "type": "object | string | number | boolean | null", "description": "字段示例值" }
    ],
    "SelectionRule": [
      { "name": "scope", "type": "endpoint | field", "required": true, "description": "规则作用范围" },
      { "name": "when", "type": "string", "required": true, "description": "适用条件" },
      { "name": "choose", "type": "string", "required": true, "description": "应选择的端点或字段值" },
      { "name": "avoid", "type": "string", "description": "不应选择的方案" },
      { "name": "reason", "type": "string", "required": true, "description": "选择原因" }
    ],
    "CallExample": [
      { "name": "title", "type": "string", "required": true, "description": "示例用途" },
      { "name": "method", "type": "GET | POST | PUT | PATCH | DELETE", "required": true, "description": "HTTP 方法" },
      { "name": "path", "type": "string", "required": true, "description": "端点模板路径" },
      { "name": "pathParams", "type": "object", "description": "路径参数值" },
      { "name": "query", "type": "object", "description": "查询参数值" },
      { "name": "headers", "type": "object", "description": "鉴权头之外的请求头" },
      { "name": "body", "type": "object | string", "description": "JSON 对象或原始请求体占位符" },
      { "name": "note", "type": "string", "description": "补充说明" },
      { "name": "next", "type": "string", "description": "建议的后续调用" }
    ],
    "SessionItem": [
      { "name": "sessionId", "type": "string", "description": "会话 ID" },
      { "name": "name", "type": "string", "description": "会话名称" },
      { "name": "host", "type": "string", "description": "主机地址" },
      { "name": "connected", "type": "boolean", "description": "SSH 是否已连接" },
      { "name": "sftpAvailable", "type": "boolean", "description": "SFTP 是否可用" },
      { "name": "connectionId", "type": "string", "required": false, "description": "当前自动化连接 ID；未连接时省略" },
      { "name": "status", "type": "connecting | connected | disconnected", "required": false, "description": "当前自动化连接状态；无运行时连接时省略" },
      { "name": "connectedAt", "type": "string", "required": false, "description": "当前连接建立时间；未连接时省略" }
    ],
    "SessionIdBody": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" }
    ],
    "ConnectionInfo": [
      { "name": "connectionId", "type": "string", "description": "连接 ID" },
      { "name": "sessionId", "type": "string", "description": "会话 ID" },
      { "name": "host", "type": "string", "description": "主机地址" },
      { "name": "port", "type": "number", "description": "SSH 端口" },
      { "name": "username", "type": "string", "description": "登录用户名" },
      { "name": "status", "type": "connecting | connected | disconnected", "description": "连接状态" },
      { "name": "connectedAt", "type": "string", "description": "连接时间" },
      { "name": "disconnectReason", "type": "string | null", "description": "断开原因；服务器未提供详情时会明确说明" },
      { "name": "reused", "type": "boolean", "description": "本次请求是否直接复用了既有连接" }
    ],
    "ExecBody": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "command", "type": "string", "required": true, "description": "要执行的命令，最大 64 KiB" },
      { "name": "timeoutMs", "type": "number", "required": false, "description": "命令超时毫秒数，省略为 30000，输入会限制到 1–300000", "default": 30000, "minimum": 1, "maximum": 300000 },
      { "name": "safetyMode", "type": "balanced | strict", "required": false, "description": "命令安全模式；strict 额外拦截常见高风险管理命令", "default": "balanced" }
    ],
    "ExecJobBody": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "command", "type": "string", "required": true, "description": "要执行的长任务命令，最大 64 KiB" },
      { "name": "timeoutMs", "type": "number", "required": false, "description": "远端任务超时毫秒数，省略为 1800000，输入会限制到 1–86400000", "default": 1800000, "minimum": 1, "maximum": 86400000 },
      { "name": "safetyMode", "type": "balanced | strict", "required": false, "description": "命令安全模式", "default": "balanced" }
    ],
    "JobPath": [
      { "name": "job_id", "type": "string", "required": true, "description": "任务 ID" }
    ],
    "JobEventsQuery": [
      { "name": "after", "type": "number", "required": false, "description": "仅重放此事件 ID 之后的事件；与 Last-Event-ID 同时提供时优先", "minimum": 0 }
    ],
    "JobEventsHeaders": [
      { "name": "Last-Event-ID", "type": "number", "required": false, "description": "SSE 断线前最后收到的事件 ID；与 after 二选一" }
    ],
    "JobSnapshot": [
      { "name": "jobId", "type": "string", "description": "任务 ID" },
      { "name": "sessionId", "type": "string", "description": "会话 ID" },
      { "name": "commandPreview", "type": "string", "description": "脱敏并截断后的命令预览" },
      { "name": "status", "type": "queued | connecting | running | canceling | completed | failed | canceled | timedOut", "description": "任务状态" },
      { "name": "timeoutMs", "type": "number", "description": "任务超时时间" },
      { "name": "createdAt", "type": "string", "description": "创建时间" },
      { "name": "startedAt", "type": "string | null", "description": "开始时间" },
      { "name": "completedAt", "type": "string | null", "description": "结束时间" },
      { "name": "exitStatus", "type": "number | null", "description": "远程命令退出码" },
      { "name": "durationMs", "type": "number | null", "description": "任务从创建到结束的总耗时" },
      { "name": "queueMs", "type": "number | null", "description": "等待执行配额的耗时" },
      { "name": "connectionMs", "type": "number | null", "description": "自动连接阶段耗时；复用连接时为 0" },
      { "name": "channelOpenMs", "type": "number | null", "description": "SSH 执行通道创建耗时" },
      { "name": "executionMs", "type": "number | null", "description": "远端命令执行耗时" },
      { "name": "timedOut", "type": "boolean", "description": "是否因超时结束" },
      { "name": "error", "type": "string | null", "description": "任务失败原因" },
      { "name": "stdout", "type": "string", "description": "标准输出尾部，最多保留 1 MiB" },
      { "name": "stderr", "type": "string", "description": "标准错误尾部，最多保留 1 MiB" },
      { "name": "stdoutBytes", "type": "number", "description": "标准输出累计字节数" },
      { "name": "stderrBytes", "type": "number", "description": "标准错误累计字节数" },
      { "name": "outputTruncated", "type": "boolean", "description": "保留输出是否已截断" },
      { "name": "lastEventId", "type": "number", "description": "最新事件 ID" }
    ],
    "JobSummary": [
      { "name": "jobId", "type": "string", "description": "任务 ID" },
      { "name": "sessionId", "type": "string", "description": "会话 ID" },
      { "name": "commandPreview", "type": "string", "description": "脱敏并截断后的命令预览" },
      { "name": "status", "type": "queued | connecting | running | canceling | completed | failed | canceled | timedOut", "description": "任务状态" },
      { "name": "timeoutMs", "type": "number", "description": "任务超时时间" },
      { "name": "createdAt", "type": "string", "description": "创建时间" },
      { "name": "startedAt", "type": "string | null", "description": "开始时间" },
      { "name": "completedAt", "type": "string | null", "description": "结束时间" },
      { "name": "exitStatus", "type": "number | null", "description": "远程命令退出码" },
      { "name": "durationMs", "type": "number | null", "description": "任务从创建到结束的总耗时" },
      { "name": "queueMs", "type": "number | null", "description": "等待执行配额的耗时" },
      { "name": "connectionMs", "type": "number | null", "description": "自动连接阶段耗时；复用连接时为 0" },
      { "name": "channelOpenMs", "type": "number | null", "description": "SSH 执行通道创建耗时" },
      { "name": "executionMs", "type": "number | null", "description": "远端命令执行耗时" },
      { "name": "timedOut", "type": "boolean", "description": "是否因超时结束" },
      { "name": "error", "type": "string | null", "description": "任务失败原因" },
      { "name": "stdoutBytes", "type": "number", "description": "标准输出累计字节数" },
      { "name": "stderrBytes", "type": "number", "description": "标准错误累计字节数" },
      { "name": "outputTruncated", "type": "boolean", "description": "保留输出是否已截断" },
      { "name": "lastEventId", "type": "number", "description": "最新事件 ID" }
    ],
    "JobEvent": [
      { "name": "id", "type": "number", "description": "SSE id" },
      { "name": "event", "type": "queued | connecting | running | stdout | stderr | canceling | completed | failed | canceled | timedOut | snapshot", "description": "SSE event 名称" },
      { "name": "timestamp", "type": "string", "description": "事件时间" },
      { "name": "payload", "type": "object", "description": "stdout/stderr 为 {text}；状态事件为 {job: JobSummary}；snapshot 为 {job: JobSnapshot}" }
    ],
    "BatchExecBody": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "commands", "type": "BatchExecItem[]", "required": true, "description": "1–32 条命令" },
      { "name": "parallel", "type": "boolean", "required": false, "description": "是否最多 4 路并行", "default": false },
      { "name": "stopOnError", "type": "boolean", "required": false, "description": "顺序模式遇错即停；parallel=true 时忽略", "default": true },
      { "name": "safetyMode", "type": "balanced | strict", "required": false, "description": "应用于全部命令的安全模式", "default": "balanced" }
    ],
    "BatchExecItem": [
      { "name": "id", "type": "string", "required": false, "description": "调用方自定义标识" },
      { "name": "command", "type": "string", "required": true, "description": "命令，最大 64 KiB" },
      { "name": "timeoutMs", "type": "number", "required": false, "description": "单条命令超时毫秒数，省略为 30000，输入会限制到 1–300000", "default": 30000, "minimum": 1, "maximum": 300000 }
    ],
    "BatchExecResponse": [
      { "name": "success", "type": "boolean", "description": "全部已执行命令是否成功" },
      { "name": "parallel", "type": "boolean", "description": "是否并行执行" },
      { "name": "outputTruncated", "type": "boolean", "description": "单项 1 MiB 尾部或批次 16 MiB 响应预算是否触发截断" },
      { "name": "connectionMs", "type": "number", "description": "批次开始前自动建立 SSH 连接的耗时；复用时为 0" },
      { "name": "durationMs", "type": "number", "description": "批次总耗时" },
      { "name": "results", "type": "BatchExecItemResult[]", "description": "按输入顺序排列的结果" }
    ],
    "BatchExecItemResult": [
      { "name": "index", "type": "number", "description": "原始命令索引" },
      { "name": "id", "type": "string", "required": false, "description": "调用方传入的自定义标识" },
      { "name": "success", "type": "boolean", "description": "命令是否正常退出" },
      { "name": "result", "type": "ExecResult", "required": false, "description": "成功发起执行时的结果" },
      { "name": "error", "type": "string", "required": false, "description": "无法执行时的具体错误" }
    ],
    "LatencyBody": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "samples", "type": "number", "required": false, "description": "SSH 往返采样次数，输入会限制到 1–10", "default": 5, "minimum": 1, "maximum": 10 }
    ],
    "LatencyProbeResult": [
      { "name": "connectionId", "type": "string", "description": "复用的 SSH 连接 ID" },
      { "name": "samplesMs", "type": "number[]", "description": "成功样本" },
      { "name": "minMs", "type": "number", "description": "最低延迟" },
      { "name": "averageMs", "type": "number", "description": "平均延迟" },
      { "name": "medianMs", "type": "number", "description": "中位延迟，UI 默认展示" },
      { "name": "maxMs", "type": "number", "description": "最高延迟" },
      { "name": "jitterMs", "type": "number", "description": "标准差抖动" },
      { "name": "failedSamples", "type": "number", "description": "失败样本数" },
      { "name": "measuredAt", "type": "string", "description": "测试完成时间" }
    ],
    "ExecResult": [
      { "name": "stdout", "type": "string", "description": "标准输出尾部，AI API 最多保留 1 MiB" },
      { "name": "stderr", "type": "string", "description": "标准错误尾部，AI API 最多保留 1 MiB" },
      { "name": "stdoutBytes", "type": "number", "description": "标准输出累计原始字节数" },
      { "name": "stderrBytes", "type": "number", "description": "标准错误累计原始字节数" },
      { "name": "outputTruncated", "type": "boolean", "description": "输出是否超过保留上限" },
      { "name": "exitStatus", "type": "number | null", "description": "远端退出码；超时固定为 124，远端未返回状态时为 null" },
      { "name": "durationMs", "type": "number", "description": "调用链总耗时，包含排队、自动连接、通道创建和命令执行" },
      { "name": "executionMs", "type": "number", "description": "发送 exec 请求到命令结束及必要清理的耗时" },
      { "name": "channelOpenMs", "type": "number", "description": "SSH 执行通道创建耗时；命中预热通道时为 0" },
      { "name": "connectionMs", "type": "number", "description": "自动建立 SSH 连接的耗时；复用连接时为 0" },
      { "name": "queueMs", "type": "number", "description": "等待会话执行并发配额的耗时" },
      { "name": "timedOut", "type": "boolean", "description": "是否超时" }
    ],
    "FilesQuery": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "path", "type": "string", "required": true, "description": "远端目录或文件路径" }
    ],
    "FilesPageQuery": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "path", "type": "string", "required": true, "description": "远端目录路径" },
      { "name": "cursor", "type": "string", "required": false, "description": "上一页返回的不透明 nextCursor；目录改变后不可复用" },
      { "name": "limit", "type": "number", "required": false, "description": "每页条目数", "default": 100, "minimum": 1, "maximum": 500 }
    ],
    "FilesPageResponse": [
      { "name": "items", "type": "FileEntry[]", "description": "当前页条目" },
      { "name": "nextCursor", "type": "string", "required": false, "description": "下一页游标；无下一页时省略" },
      { "name": "hasMore", "type": "boolean", "description": "是否还有下一页" }
    ],
    "FileEntry": [
      { "name": "name", "type": "string", "description": "文件名" },
      { "name": "path", "type": "string", "description": "远端完整路径" },
      { "name": "fileType", "type": "directory | file | symlink | other", "description": "文件类型" },
      { "name": "size", "type": "number", "description": "文件大小，字节" },
      { "name": "modifiedAt", "type": "string", "description": "最后修改时间；远端未提供时为空" },
      { "name": "permissions", "type": "string", "description": "文件类型与权限文本" },
      { "name": "owner", "type": "string", "description": "远端用户与用户组" }
    ],
    "UploadQuery": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "remotePath", "type": "string", "required": true, "description": "远端目标文件路径" },
      { "name": "sha256", "type": "string", "required": false, "description": "可选的 64 位十六进制 SHA-256；不一致时不会替换目标文件" }
    ],
    "UploadResponse": [
      { "name": "success", "type": "boolean", "description": "是否成功" },
      { "name": "remotePath", "type": "string", "description": "远端目标文件路径" },
      { "name": "size", "type": "number", "description": "写入字节数" },
      { "name": "sha256", "type": "string", "required": false, "description": "启用校验时服务端计算的 SHA-256" }
    ],
    "DownloadQuery": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "path", "type": "string", "required": true, "description": "远端文件路径" }
    ],
    "DownloadHeaders": [
      { "name": "Range", "type": "string", "required": false, "description": "仅支持单段 bytes 范围；格式错误返回 400，多段或越界返回 416", "example": "bytes=0-1048575" }
    ],
    "CacheValidationHeaders": [
      { "name": "If-None-Match", "type": "string", "required": false, "description": "上次响应的 ETag；内容未变时返回 304" }
    ],
    "TunnelPath": [
      { "name": "id", "type": "string", "required": true, "description": "隧道 ID" }
    ],
    "TunnelInput": [
      { "name": "name", "type": "string", "required": true, "description": "隧道名称", "example": "SSH Tunnel" },
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "forwardType", "type": "local | remote | dynamic", "required": true, "description": "转发类型" },
      { "name": "bindHost", "type": "string", "required": true, "description": "监听地址", "example": "127.0.0.1" },
      { "name": "bindPort", "type": "number", "required": true, "description": "监听端口；0 由系统分配，实际端口由 start 响应返回", "minimum": 0, "maximum": 65535 },
      { "name": "targetHost", "type": "string", "required": true, "description": "local/remote 必填；dynamic 传空字符串", "example": "127.0.0.1" },
      { "name": "targetPort", "type": "number", "required": true, "description": "local/remote 为 1–65535；dynamic 传 0", "minimum": 0, "maximum": 65535, "example": 22 }
    ],
    "TunnelPatch": [
      { "name": "name", "type": "string", "required": false, "description": "新的隧道名称", "example": "SSH Tunnel Updated" },
      { "name": "sessionId", "type": "string", "required": false, "description": "新的会话 ID；原会话和目标会话都必须已授权" },
      { "name": "forwardType", "type": "local | remote | dynamic", "required": false, "description": "新的转发类型" },
      { "name": "bindHost", "type": "string", "required": false, "description": "新的监听地址" },
      { "name": "bindPort", "type": "number", "required": false, "description": "新的监听端口", "minimum": 0, "maximum": 65535 },
      { "name": "targetHost", "type": "string", "required": false, "description": "新的目标主机" },
      { "name": "targetPort", "type": "number", "required": false, "description": "新的目标端口", "minimum": 0, "maximum": 65535 }
    ],
    "TunnelConfig": [
      { "name": "id", "type": "string", "description": "隧道 ID" },
      { "name": "name", "type": "string", "description": "隧道名称" },
      { "name": "sessionId", "type": "string", "description": "会话 ID" },
      { "name": "forwardType", "type": "local | remote | dynamic", "description": "转发类型" },
      { "name": "bindHost", "type": "string", "description": "监听地址" },
      { "name": "bindPort", "type": "number", "description": "监听端口" },
      { "name": "targetHost", "type": "string", "description": "目标主机" },
      { "name": "targetPort", "type": "number", "description": "目标端口" },
      { "name": "createdAt", "type": "string", "description": "创建时间" },
      { "name": "updatedAt", "type": "string", "description": "更新时间" }
    ],
    "TunnelStartResponse": [
      { "name": "forwardId", "type": "string", "description": "转发 ID" },
      { "name": "bindHost", "type": "string", "description": "实际监听地址" },
      { "name": "bindPort", "type": "number", "description": "实际监听端口" }
    ],
    "SuccessResponse": [
      { "name": "success", "type": "boolean", "description": "是否成功" }
    ],
    "ApiError": [
      { "name": "error", "type": "string", "required": true, "description": "兼容旧调用方的错误文本" },
      { "name": "code", "type": "string", "required": true, "description": "稳定的机器可读错误码" },
      { "name": "message", "type": "string", "required": true, "description": "面向调用方的错误说明" },
      { "name": "retryable", "type": "boolean", "required": true, "description": "修正输入前提下是否适合重试" },
      { "name": "requestId", "type": "string", "required": true, "description": "本次错误响应的追踪 ID" }
    ],
    "BackupSettings": [
      { "name": "localDirectory", "type": "string | null", "description": "本地备份目录；null 表示未配置", "default": null },
      { "name": "autoEnabled", "type": "boolean", "description": "是否启用本地自动备份", "default": false },
      { "name": "frequency", "type": "manual | hourly | daily | weekly", "description": "自动备份频率", "default": "daily" },
      { "name": "retentionCount", "type": "number", "description": "每种目标和状态保留的最大记录数", "default": 10, "minimum": 1, "maximum": 65535 },
      { "name": "retentionDays", "type": "number", "description": "记录保留天数；0 表示不按天数清理", "default": 30, "minimum": 0, "maximum": 65535 },
      { "name": "cloud", "type": "CloudBackupSettings", "description": "云端备份设置" }
    ],
    "BackupSettingsPatch": [
      { "name": "localDirectory", "type": "string | null", "required": false, "description": "新的本地备份目录；null 清除配置" },
      { "name": "autoEnabled", "type": "boolean", "required": false, "description": "是否启用本地自动备份" },
      { "name": "frequency", "type": "manual | hourly | daily | weekly", "required": false, "description": "自动备份频率" },
      { "name": "retentionCount", "type": "number", "required": false, "description": "最大保留份数", "minimum": 1, "maximum": 65535, "example": 20 },
      { "name": "retentionDays", "type": "number", "required": false, "description": "保留天数；0 不按天数清理", "minimum": 0, "maximum": 65535 },
      { "name": "cloud", "type": "CloudBackupSettingsPatch", "required": false, "description": "云端设置局部更新" }
    ],
    "CloudBackupSettings": [
      { "name": "enabled", "type": "boolean", "description": "是否启用云端备份配置", "default": false },
      { "name": "autoEnabled", "type": "boolean", "description": "是否启用云端自动备份", "default": false },
      { "name": "kind", "type": "webdav | s3", "description": "启用的云端类型", "default": "webdav" },
      { "name": "webdav", "type": "WebdavBackupConfig", "description": "WebDAV 配置" },
      { "name": "s3", "type": "S3BackupConfig", "description": "S3 配置" }
    ],
    "CloudBackupSettingsPatch": [
      { "name": "enabled", "type": "boolean", "required": false, "description": "是否启用云端配置" },
      { "name": "autoEnabled", "type": "boolean", "required": false, "description": "是否启用云端自动备份" },
      { "name": "kind", "type": "webdav | s3", "required": false, "description": "启用的云端类型" },
      { "name": "webdav", "type": "WebdavBackupConfigPatch", "required": false, "description": "WebDAV 局部更新" },
      { "name": "s3", "type": "S3BackupConfigPatch", "required": false, "description": "S3 局部更新" }
    ],
    "WebdavBackupConfig": [
      { "name": "endpoint", "type": "string", "description": "WebDAV 服务地址" },
      { "name": "username", "type": "string", "description": "用户名" },
      { "name": "password", "type": "string", "required": false, "description": "密码；仅写入，读取响应固定为空；更新时为空会保留原值" },
      { "name": "remotePath", "type": "string", "description": "远端备份目录" }
    ],
    "WebdavBackupConfigPatch": [
      { "name": "endpoint", "type": "string", "required": false, "description": "WebDAV 服务地址" },
      { "name": "username", "type": "string", "required": false, "description": "用户名" },
      { "name": "password", "type": "string", "required": false, "description": "新密码；省略或空字符串保留原值" },
      { "name": "remotePath", "type": "string", "required": false, "description": "远端备份目录" }
    ],
    "S3BackupConfig": [
      { "name": "endpoint", "type": "string", "description": "S3 兼容服务地址" },
      { "name": "region", "type": "string", "description": "区域", "default": "us-east-1" },
      { "name": "bucket", "type": "string", "description": "存储桶" },
      { "name": "accessKeyId", "type": "string", "description": "访问密钥 ID" },
      { "name": "secretAccessKey", "type": "string", "required": false, "description": "访问密钥；仅写入，读取响应固定为空；更新时为空会保留原值" },
      { "name": "prefix", "type": "string", "description": "对象键前缀" },
      { "name": "pathStyle", "type": "boolean", "description": "是否使用路径风格地址", "default": false }
    ],
    "S3BackupConfigPatch": [
      { "name": "endpoint", "type": "string", "required": false, "description": "S3 兼容服务地址" },
      { "name": "region", "type": "string", "required": false, "description": "区域" },
      { "name": "bucket", "type": "string", "required": false, "description": "存储桶" },
      { "name": "accessKeyId", "type": "string", "required": false, "description": "访问密钥 ID" },
      { "name": "secretAccessKey", "type": "string", "required": false, "description": "新访问密钥；省略或空字符串保留原值" },
      { "name": "prefix", "type": "string", "required": false, "description": "对象键前缀" },
      { "name": "pathStyle", "type": "boolean", "required": false, "description": "是否使用路径风格地址" }
    ],
    "BackupRecord": [
      { "name": "id", "type": "string", "description": "备份记录 ID" },
      { "name": "fileName", "type": "string", "description": "备份文件名" },
      { "name": "targetKind", "type": "local | webdav | s3", "description": "备份目标类型" },
      { "name": "targetPath", "type": "string", "description": "备份目标路径" },
      { "name": "size", "type": "number", "description": "文件大小，字节" },
      { "name": "status", "type": "success | failed", "description": "备份状态" },
      { "name": "error", "type": "string | null", "description": "失败原因" },
      { "name": "createdAt", "type": "string", "description": "创建时间" }
    ],
    "BackupRecordPath": [
      { "name": "id", "type": "string", "required": true, "description": "备份记录 ID" }
    ],
    "DeleteBackupRecordQuery": [
      { "name": "deleteFile", "type": "boolean", "required": false, "description": "是否同时删除可确认归属的备份文件", "default": false }
    ]
  },
  "selectionRules": [
    { "scope": "endpoint", "when": "只需验证密钥和服务可用性", "choose": "GET /api/auth", "avoid": "下载完整字段库", "reason": "响应最小且附带端点概览" },
    { "scope": "endpoint", "when": "AI 需要一次获得全部端点、字段、约束、规则和示例", "choose": "GET /api/fields", "avoid": "每次执行前重新读取", "reason": "按 version 或 ETag 缓存，If-None-Match 命中时返回 304" },
    { "scope": "endpoint", "when": "OpenAPI 客户端、代码生成器或内置调试台需要标准描述", "choose": "GET /openapi.json", "avoid": "自行转换字段库", "reason": "文档由同一字段库动态生成" },
    { "scope": "endpoint", "when": "需要提前完成 SSH 握手或单独确认连接", "choose": "POST /api/connect", "avoid": "所有操作前固定调用 connect", "reason": "exec、jobs、latency 和文件端点会自动连接并复用" },
    { "scope": "endpoint", "when": "执行一条可在 5 分钟内完成且无需实时输出的命令", "choose": "POST /api/exec", "avoid": "POST /api/jobs", "reason": "单次响应最简单" },
    { "scope": "endpoint", "when": "同一会话需要执行 1–32 条短命令", "choose": "POST /api/exec/batch", "avoid": "循环发送大量独立 exec", "reason": "支持顺序或最多 4 路并行并保持输入顺序" },
    { "scope": "endpoint", "when": "命令耗时较长、需要实时 stdout/stderr 或需要取消", "choose": "POST /api/jobs", "avoid": "长时间占用 POST /api/exec", "reason": "可查询状态、SSE 续传和取消" },
    { "scope": "endpoint", "when": "目录较小且需要一次获取全部条目", "choose": "GET /api/files", "avoid": "对大型目录反复全量读取", "reason": "兼容端点返回完整数组" },
    { "scope": "endpoint", "when": "目录较大或条目数量未知", "choose": "GET /api/files/page 并沿 nextCursor 翻页", "avoid": "GET /api/files 全量读取", "reason": "分页端点会在取得当前页和一条探测项后关闭目录句柄" },
    { "scope": "endpoint", "when": "只需一个文件或目录的元数据", "choose": "GET /api/files/stat", "avoid": "列出父目录后自行查找", "reason": "直接读取目标路径，往返和返回体更小" },
    { "scope": "endpoint", "when": "创建或修改隧道", "choose": "POST 创建、PATCH 仅提交变化字段，再按需 start", "avoid": "把配置写入视为已启动", "reason": "PATCH 是真正的局部更新，配置持久化与运行态启动分离" },
    { "scope": "endpoint", "when": "只修改少量自动备份字段", "choose": "PATCH /api/backup/settings", "avoid": "先 GET 再回传完整设置", "reason": "采用 JSON Merge Patch，未提交字段保持不变" },
    { "scope": "endpoint", "when": "需要完整替换自动备份设置", "choose": "PUT /api/backup/settings", "avoid": "把 PUT 当作局部更新", "reason": "PUT 保持完整替换语义；空密码和空 secretAccessKey 保留原值" },
    { "scope": "field", "when": "仅需防止灾难性命令", "choose": "safetyMode=balanced", "avoid": "不必要地使用 strict", "reason": "strict 会额外拒绝常见管理命令、远程脚本和重启操作" },
    { "scope": "field", "when": "SSE 断线续传", "choose": "Last-Event-ID 或 after 二选一", "avoid": "同时提供不同游标", "reason": "同时提供时 after 优先" },
    { "scope": "field", "when": "批量命令需要遇错停止", "choose": "parallel=false 且 stopOnError=true", "avoid": "parallel=true", "reason": "并行模式忽略 stopOnError" },
    { "scope": "field", "when": "forwardType=dynamic", "choose": "targetHost=\"\" 且 targetPort=0", "avoid": "填写固定目标", "reason": "动态隧道由 SOCKS 客户端逐次选择目标" },
    { "scope": "field", "when": "配置云备份", "choose": "按 cloud.kind 只使用 webdav 或 s3 对应配置", "avoid": "混用两套凭据", "reason": "运行时只读取当前 kind 对应配置" }
  ],
  "examples": {
    "listSessions": {
      "title": "查询授权会话",
      "method": "GET",
      "path": "/api/sessions"
    },
    "exec": {
      "title": "执行短命令",
      "method": "POST",
      "path": "/api/exec",
      "body": { "sessionId": "<session_id>", "command": "uname -a", "timeoutMs": 30000, "safetyMode": "balanced" }
    },
    "batchExec": {
      "title": "并行执行多条短命令",
      "method": "POST",
      "path": "/api/exec/batch",
      "body": {
        "sessionId": "<session_id>",
        "commands": [
          { "id": "system", "command": "uname -a", "timeoutMs": 30000 },
          { "id": "disk", "command": "df -h", "timeoutMs": 30000 }
        ],
        "parallel": true,
        "stopOnError": false,
        "safetyMode": "balanced"
      }
    },
    "createJob": {
      "title": "创建可追踪长任务",
      "method": "POST",
      "path": "/api/jobs",
      "body": { "sessionId": "<session_id>", "command": "docker compose pull && docker compose up -d", "timeoutMs": 1800000, "safetyMode": "balanced" },
      "next": "使用返回的 jobId 查询 /api/jobs/{job_id}、订阅 events 或调用 cancel"
    },
    "jobEvents": {
      "title": "续传任务事件",
      "method": "GET",
      "path": "/api/jobs/{job_id}/events",
      "pathParams": { "job_id": "<job_id>" },
      "headers": { "Accept": "text/event-stream", "Last-Event-ID": "<last_event_id>" }
    },
    "listFiles": {
      "title": "浏览远端目录",
      "method": "GET",
      "path": "/api/files",
      "query": { "sessionId": "<session_id>", "path": "/var/log" }
    },
    "listFilesPage": {
      "title": "分页浏览大型目录",
      "method": "GET",
      "path": "/api/files/page",
      "query": { "sessionId": "<session_id>", "path": "/var/log", "limit": 100 },
      "next": "若 hasMore=true，将 nextCursor 原样放入下一次请求的 cursor"
    },
    "fileStat": {
      "title": "读取单个文件元数据",
      "method": "GET",
      "path": "/api/files/stat",
      "query": { "sessionId": "<session_id>", "path": "/var/log/syslog" }
    },
    "uploadFile": {
      "title": "上传完整文件",
      "method": "PUT",
      "path": "/api/upload",
      "query": { "sessionId": "<session_id>", "remotePath": "/tmp/helm-upload.bin", "sha256": "<64_hex_sha256>" },
      "headers": { "Content-Type": "application/octet-stream" },
      "body": "<raw_file_bytes>",
      "note": "sha256 可省略；提供时在原子替换前校验，失败不会覆盖目标文件"
    },
    "rangeDownload": {
      "title": "下载文件前 1 MiB",
      "method": "GET",
      "path": "/api/download",
      "query": { "sessionId": "<session_id>", "path": "/var/log/syslog" },
      "headers": { "Range": "bytes=0-1048575" }
    },
    "latency": {
      "title": "检测 SSH 往返延迟",
      "method": "POST",
      "path": "/api/latency",
      "body": { "sessionId": "<session_id>", "samples": 5 }
    },
    "createTunnel": {
      "title": "创建本地端口转发",
      "method": "POST",
      "path": "/api/tunnels",
      "body": { "name": "PostgreSQL", "sessionId": "<session_id>", "forwardType": "local", "bindHost": "127.0.0.1", "bindPort": 0, "targetHost": "127.0.0.1", "targetPort": 5432 },
      "next": "从返回列表取得 id，再调用 POST /api/tunnels/{id}/start"
    },
    "updateBackupSettings": {
      "title": "完整更新本地备份设置",
      "method": "PUT",
      "path": "/api/backup/settings",
      "body": {
        "localDirectory": "E:\\Backups\\HelM",
        "autoEnabled": true,
        "frequency": "daily",
        "retentionCount": 10,
        "retentionDays": 30,
        "cloud": {
          "enabled": false,
          "autoEnabled": false,
          "kind": "webdav",
          "webdav": { "endpoint": "", "username": "", "password": "", "remotePath": "" },
          "s3": { "endpoint": "", "region": "us-east-1", "bucket": "", "accessKeyId": "", "secretAccessKey": "", "prefix": "", "pathStyle": false }
        }
      }
    },
    "patchBackupSettings": {
      "title": "局部修改备份保留策略",
      "method": "PATCH",
      "path": "/api/backup/settings",
      "body": { "retentionCount": 20, "retentionDays": 60 }
    },
    "runBackup": {
      "title": "立即运行已配置备份",
      "method": "POST",
      "path": "/api/backup/run",
      "note": "手动运行会使用已配置的本地和云端目标，不受 autoEnabled 开关限制"
    }
  },
  "rules": [
    "所有端点都使用 Authorization: Bearer <api_key>；JSON 请求使用 application/json，upload 使用 application/octet-stream；字段库与 OpenAPI 支持 ETag 重验证。",
    "会话操作仅限授权列表；exec、jobs、latency、files、upload、download 和隧道启动会自动连接并复用 SSH/SFTP，未知主机指纹仍需在主窗口确认。",
    "exec、exec/batch 与 jobs 共用执行配额：每会话 4 条、全局 16 条，排队超过 3 秒返回 429 或任务失败。",
    "exec 默认 30 秒且最长 5 分钟；超时固定 exitStatus=124、timedOut=true，并终止已跟踪的远端进程组。stdout/stderr 各保留尾部 1 MiB，耗时由 durationMs 等字段拆分。",
    "长任务默认 30 分钟、最长 24 小时；创建立即返回 202，connecting 和排队阶段均可取消；每会话最多 4 个、总记录最多 100 个，完成后保留 30 分钟。",
    "SSE 历史最多 1024 个事件或 4 MiB，支持 Last-Event-ID/after 续传；终态事件后关闭，追赶失败时发送 snapshot。",
    "upload 必须单次提交完整文件，最大 512 MiB，可选 sha256 在原子替换前校验；download 仅支持单段 Range，格式错误返回 400，多段或越界返回 416。",
    "balanced 只拦截灾难性操作，strict 额外拦截常见高风险管理命令；API 日志会脱敏令牌、密码、认证头和私钥。",
    "授权会话为空时服务不会启动；运行中清空授权列表会停止服务并取消相关长任务。"
  ]
}
"###;

pub fn catalog_json() -> Result<&'static Value, String> {
    if let Some(catalog) = API_FIELD_CATALOG.get() {
        return Ok(catalog);
    }
    let catalog = serde_json::from_str(API_FIELD_CATALOG_JSON)
        .map_err(|error| format!("字段库 JSON 无效: {error}"))?;
    let _ = API_FIELD_CATALOG.set(catalog);
    Ok(API_FIELD_CATALOG
        .get()
        .expect("field catalog initialized before return"))
}

#[cfg(test)]
mod tests {
    use super::catalog_json;
    use std::collections::HashSet;

    #[test]
    fn catalog_json_is_valid() {
        let catalog = catalog_json().expect("api field catalog should be valid json");
        assert_eq!(catalog["version"].as_u64(), Some(10));
        assert_eq!(catalog["endpoints"].as_array().map(Vec::len), Some(31));
        assert!(catalog["schemas"]
            .as_object()
            .is_some_and(|items| !items.is_empty()));
        assert!(catalog["selectionRules"]
            .as_array()
            .is_some_and(|items| items.len() >= 10));
        assert!(catalog["examples"]
            .as_object()
            .is_some_and(|items| items.len() >= 10));
    }

    #[test]
    fn every_endpoint_schema_reference_exists() {
        let catalog = catalog_json().unwrap();
        let schema_names = catalog["schemas"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        for endpoint in catalog["endpoints"].as_array().unwrap() {
            for field in [
                "responseSchema",
                "bodySchema",
                "querySchema",
                "pathSchema",
                "headerSchema",
            ] {
                let Some(reference) = endpoint[field].as_str() else {
                    continue;
                };
                let reference = reference.strip_suffix("[]").unwrap_or(reference);
                if reference == "binary" {
                    continue;
                }
                assert!(
                    schema_names.contains(reference),
                    "missing schema {reference} for {} {}",
                    endpoint["method"].as_str().unwrap_or("?"),
                    endpoint["path"].as_str().unwrap_or("?")
                );
            }
        }
    }

    #[test]
    fn endpoint_summaries_are_clear_and_compact() {
        let catalog = catalog_json().unwrap();
        for endpoint in catalog["endpoints"].as_array().unwrap() {
            let summary = endpoint["summary"].as_str().unwrap_or_default();
            let length = summary.chars().count();
            assert!(
                (6..=18).contains(&length),
                "summary length should stay between 6 and 18 characters: {summary}"
            );
        }
    }

    #[test]
    fn examples_reference_existing_endpoints_without_repeating_auth() {
        let catalog = catalog_json().unwrap();
        let endpoints = catalog["endpoints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|endpoint| {
                (
                    endpoint["method"].as_str().unwrap(),
                    endpoint["path"].as_str().unwrap(),
                )
            })
            .collect::<HashSet<_>>();
        for (id, example) in catalog["examples"].as_object().unwrap() {
            let method = example["method"].as_str().unwrap_or_default();
            let path = example["path"].as_str().unwrap_or_default();
            assert!(
                endpoints.contains(&(method, path)),
                "example {id} references missing endpoint {method} {path}"
            );
            assert!(
                example["headers"].get("Authorization").is_none(),
                "example {id} should reuse top-level auth instead of repeating it"
            );
        }
    }

    #[test]
    fn global_rules_stay_compact_and_field_constraints_are_explicit() {
        let catalog = catalog_json().unwrap();
        let rules = catalog["rules"].as_array().unwrap();
        assert!(rules.len() <= 9);
        assert!(rules.iter().all(|rule| rule
            .as_str()
            .is_some_and(|text| text.chars().count() <= 180)));
        assert_eq!(
            catalog["schemas"]["ExecBody"][2]["default"].as_u64(),
            Some(30_000)
        );
        assert_eq!(
            catalog["schemas"]["DeleteBackupRecordQuery"][0]["default"].as_bool(),
            Some(false)
        );
        assert_eq!(
            catalog["endpoints"]
                .as_array()
                .unwrap()
                .iter()
                .find(|endpoint| endpoint["path"] == "/api/download")
                .and_then(|endpoint| endpoint["headerSchema"].as_str()),
            Some("DownloadHeaders")
        );
    }
}
