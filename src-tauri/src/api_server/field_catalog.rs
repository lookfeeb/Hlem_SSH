use serde_json::Value;

const API_FIELD_CATALOG_JSON: &str = r###"
{
  "version": 1,
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
      "summary": "鉴权探活与端点目录",
      "responseSchema": "AuthDirectory"
    },
    {
      "category": "元信息",
      "method": "GET",
      "path": "/api/fields",
      "summary": "返回本字段库，供 AI 或外部工具动态读取全部端点字段",
      "responseSchema": "ApiFieldCatalog"
    },
    {
      "category": "会话",
      "method": "GET",
      "path": "/api/sessions",
      "summary": "列出已连接会话",
      "responseSchema": "SessionItem[]"
    },
    {
      "category": "会话",
      "method": "POST",
      "path": "/api/connect",
      "summary": "拉起 SSH 连接，幂等，已连接则直接返回当前连接信息",
      "bodySchema": "SessionIdBody",
      "responseSchema": "ConnectionInfo"
    },
    {
      "category": "会话",
      "method": "POST",
      "path": "/api/disconnect",
      "summary": "断开指定会话",
      "bodySchema": "SessionIdBody",
      "responseSchema": "SuccessResponse"
    },
    {
      "category": "操作",
      "method": "POST",
      "path": "/api/exec",
      "summary": "在远端会话执行命令并一次性返回结果",
      "bodySchema": "ExecBody",
      "responseSchema": "ExecResult"
    },
    {
      "category": "文件",
      "method": "GET",
      "path": "/api/files",
      "summary": "列出远端目录文件",
      "querySchema": "FilesQuery",
      "responseSchema": "FileEntry[]"
    },
    {
      "category": "文件",
      "method": "PUT",
      "path": "/api/upload",
      "summary": "上传文件原始字节到远端路径",
      "querySchema": "UploadQuery",
      "bodyRaw": "文件原始字节流",
      "responseSchema": "UploadResponse"
    },
    {
      "category": "文件",
      "method": "GET",
      "path": "/api/download",
      "summary": "下载远端文件，支持 Range: bytes=start-end",
      "querySchema": "DownloadQuery",
      "responseSchema": "binary"
    },
    {
      "category": "隧道",
      "method": "GET",
      "path": "/api/tunnels",
      "summary": "列出隧道配置",
      "responseSchema": "TunnelConfig[]"
    },
    {
      "category": "隧道",
      "method": "POST",
      "path": "/api/tunnels",
      "summary": "创建隧道配置并返回完整列表",
      "bodySchema": "TunnelInput",
      "responseSchema": "TunnelConfig[]"
    },
    {
      "category": "隧道",
      "method": "PATCH",
      "path": "/api/tunnels/{id}",
      "summary": "更新隧道配置并返回完整列表",
      "pathSchema": "TunnelPath",
      "bodySchema": "TunnelInput",
      "responseSchema": "TunnelConfig[]"
    },
    {
      "category": "隧道",
      "method": "DELETE",
      "path": "/api/tunnels/{id}",
      "summary": "删除隧道配置并返回完整列表",
      "pathSchema": "TunnelPath",
      "responseSchema": "TunnelConfig[]"
    },
    {
      "category": "隧道",
      "method": "POST",
      "path": "/api/tunnels/{id}/start",
      "summary": "启动指定隧道",
      "pathSchema": "TunnelPath",
      "responseSchema": "TunnelStartResponse"
    },
    {
      "category": "隧道",
      "method": "POST",
      "path": "/api/tunnels/{id}/stop",
      "summary": "停止指定隧道",
      "pathSchema": "TunnelPath",
      "responseSchema": "SuccessResponse"
    },
    {
      "category": "备份",
      "method": "GET",
      "path": "/api/backup/settings",
      "summary": "读取备份设置",
      "responseSchema": "BackupSettings"
    },
    {
      "category": "备份",
      "method": "PUT",
      "path": "/api/backup/settings",
      "summary": "更新备份设置",
      "bodySchema": "BackupSettings",
      "responseSchema": "BackupSettings"
    },
    {
      "category": "备份",
      "method": "GET",
      "path": "/api/backup/records",
      "summary": "读取备份记录",
      "responseSchema": "BackupRecord[]"
    },
    {
      "category": "备份",
      "method": "POST",
      "path": "/api/backup/run",
      "summary": "立即执行一次备份",
      "responseSchema": "BackupRecord[]"
    },
    {
      "category": "备份",
      "method": "DELETE",
      "path": "/api/backup/records/{id}",
      "summary": "删除备份记录，可选同时删除备份文件",
      "pathSchema": "BackupRecordPath",
      "querySchema": "DeleteBackupRecordQuery",
      "responseSchema": "BackupRecord[]"
    }
  ],
  "schemas": {
    "AuthDirectory": [
      { "name": "authenticated", "type": "boolean", "description": "鉴权是否通过" },
      { "name": "auth", "type": "string", "description": "鉴权头格式" },
      { "name": "rest", "type": "object", "description": "端点目录" }
    ],
    "ApiFieldCatalog": [
      { "name": "version", "type": "number", "description": "字段库版本" },
      { "name": "title", "type": "string", "description": "字段库标题" },
      { "name": "description", "type": "string", "description": "API 简述" },
      { "name": "auth", "type": "object", "description": "鉴权说明" },
      { "name": "contentType", "type": "string", "description": "JSON 请求默认 Content-Type" },
      { "name": "endpoints", "type": "EndpointField[]", "description": "端点字段列表" },
      { "name": "schemas", "type": "Record<string, Field[]>", "description": "可复用字段结构" },
      { "name": "rules", "type": "string[]", "description": "调用规则" }
    ],
    "SessionItem": [
      { "name": "sessionId", "type": "string", "description": "会话 ID" },
      { "name": "name", "type": "string", "description": "会话名称" },
      { "name": "host", "type": "string", "description": "主机地址" },
      { "name": "connected", "type": "boolean", "description": "SSH 是否已连接" },
      { "name": "sftpAvailable", "type": "boolean", "description": "SFTP 是否可用" }
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
      { "name": "status", "type": "string", "description": "连接状态" },
      { "name": "connectedAt", "type": "string", "description": "连接时间" }
    ],
    "ExecBody": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "command", "type": "string", "required": true, "description": "要执行的命令" },
      { "name": "timeoutMs", "type": "number", "required": false, "description": "超时时间，默认 30000" }
    ],
    "ExecResult": [
      { "name": "stdout", "type": "string", "description": "标准输出" },
      { "name": "stderr", "type": "string", "description": "标准错误" },
      { "name": "exitStatus", "type": "number | null", "description": "退出码，超时可能为空或为 124" },
      { "name": "durationMs", "type": "number", "description": "耗时毫秒" },
      { "name": "timedOut", "type": "boolean", "description": "是否超时" }
    ],
    "FilesQuery": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "path", "type": "string", "required": true, "description": "远端目录路径" }
    ],
    "FileEntry": [
      { "name": "name", "type": "string", "description": "文件名" },
      { "name": "path", "type": "string", "description": "远端完整路径" },
      { "name": "fileType", "type": "directory | file | symlink | other", "description": "文件类型" },
      { "name": "size", "type": "number", "description": "文件大小，字节" }
    ],
    "UploadQuery": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "remotePath", "type": "string", "required": true, "description": "远端目标文件路径" }
    ],
    "UploadResponse": [
      { "name": "success", "type": "boolean", "description": "是否成功" },
      { "name": "remotePath", "type": "string", "description": "远端目标文件路径" },
      { "name": "size", "type": "number", "description": "写入字节数" }
    ],
    "DownloadQuery": [
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "path", "type": "string", "required": true, "description": "远端文件路径" }
    ],
    "TunnelPath": [
      { "name": "id", "type": "string", "required": true, "description": "隧道 ID" }
    ],
    "TunnelInput": [
      { "name": "name", "type": "string", "required": true, "description": "隧道名称" },
      { "name": "sessionId", "type": "string", "required": true, "description": "会话 ID" },
      { "name": "forwardType", "type": "local | remote | dynamic", "required": true, "description": "转发类型" },
      { "name": "bindHost", "type": "string", "required": true, "description": "监听地址" },
      { "name": "bindPort", "type": "number", "required": true, "description": "监听端口" },
      { "name": "targetHost", "type": "string", "required": true, "description": "目标主机，dynamic 可留空" },
      { "name": "targetPort", "type": "number", "required": true, "description": "目标端口，dynamic 可为 0" }
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
    "BackupSettings": [
      { "name": "localDirectory", "type": "string | null", "description": "本地备份目录" },
      { "name": "autoEnabled", "type": "boolean", "description": "是否启用本地自动备份" },
      { "name": "frequency", "type": "manual | hourly | daily | weekly", "description": "自动备份频率" },
      { "name": "retentionCount", "type": "number", "description": "保留份数" },
      { "name": "retentionDays", "type": "number", "description": "保留天数" },
      { "name": "cloud", "type": "CloudBackupSettings", "description": "云端备份设置" }
    ],
    "CloudBackupSettings": [
      { "name": "enabled", "type": "boolean", "description": "云端备份是否已配置" },
      { "name": "autoEnabled", "type": "boolean", "description": "是否启用云端自动备份" },
      { "name": "kind", "type": "none | webdav | s3", "description": "云端类型" },
      { "name": "webdav", "type": "WebdavBackupConfig", "description": "WebDAV 配置" },
      { "name": "s3", "type": "S3BackupConfig", "description": "S3 配置" }
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
      { "name": "deleteFile", "type": "boolean", "required": false, "description": "是否同时删除备份文件" }
    ]
  },
  "rules": [
    "所有端点都需要 Authorization: Bearer <api_key>。",
    "POST/PUT/PATCH 请求默认使用 Content-Type: application/json；/api/upload 例外，body 是原始字节流。",
    "操作前先 POST /api/connect。错误中含“未连接”时，先连接再重试。",
    "未知主机密钥不会自动信任，需用户在 HelM 主窗口确认指纹。",
    "exec 默认 30s 超时；超时返回 exitStatus=124 且 timedOut=true。",
    "危险命令会被拒绝，不要尝试规避。"
  ]
}
"###;

pub fn catalog_json() -> Result<Value, serde_json::Error> {
    serde_json::from_str(API_FIELD_CATALOG_JSON)
}

#[cfg(test)]
mod tests {
    use super::catalog_json;

    #[test]
    fn catalog_json_is_valid() {
        let catalog = catalog_json().expect("api field catalog should be valid json");
        assert_eq!(catalog["version"].as_u64(), Some(1));
        assert!(catalog["endpoints"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        assert!(catalog["schemas"]
            .as_object()
            .is_some_and(|items| !items.is_empty()));
    }
}
