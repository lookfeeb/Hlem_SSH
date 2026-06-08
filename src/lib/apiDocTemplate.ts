export interface ApiDocParams {
  port: number;
  apiKey: string;
  sessionId: string;
  sessionName?: string;
  sessionHost?: string;
  sessions?: Array<{ id: string; name: string; host: string }>;
}

export function buildApiDoc(params: ApiDocParams): string {
  const { port, apiKey, sessionId, sessionName, sessionHost, sessions = [] } = params;
  const sid = sessionId || "<sessionId>";
  const sessionLine = sessions.length > 1
    ? `会话: ${sessions.map((session) => `${session.name} (${session.host}) | ID: ${session.id}`).join("; ")} （下文 \`<sid>\` 替换为其中一个 ID）`
    : sessionName
      ? `会话: ${sessionName}${sessionHost ? ` (${sessionHost})` : ""} | ID: ${sid} （下文 \`<sid>\` 替换为此 ID）`
      : "模式: 全部会话（下文 `<sid>` 为占位，先用 GET /api/sessions 获取实际值）";

  return `# HelM AI API

本地 SSH/SFTP 网关。**仅提供 HTTP REST**。

## 接入

- Base: \`http://127.0.0.1:${port}\` （下文记作 \`<base>\`）
- Auth: header \`Authorization: Bearer ${apiKey}\`
- ${sessionLine}

## REST 端点

所有端点用 \`Authorization: Bearer\` 鉴权。POST/PUT/PATCH 请求 body 为 JSON（\`Content-Type: application/json\`）。

**会话**
- \`GET <base>/api/sessions\` → 已连接会话数组
- \`POST <base>/api/connect\` \`{sessionId}\` → ConnectionInfo（幂等，已连即返）
- \`POST <base>/api/disconnect\` \`{sessionId}\` → \`{success}\`

**操作**
- \`POST <base>/api/exec\` \`{sessionId, command, timeoutMs?}\` → \`{stdout, stderr, exitStatus, durationMs, timedOut}\`
- \`GET <base>/api/files?sessionId=&path=\` → 文件数组

**文件传输**
- \`PUT <base>/api/upload?sessionId=&remotePath=\` body 是字节流 → \`{success, remotePath, size}\`
- \`GET <base>/api/download?sessionId=&path=\` 支持 \`Range: bytes=start-end\`，越界返回 416

**隧道**（CRUD + start/stop）
- \`GET <base>/api/tunnels\` → 隧道数组
- \`POST <base>/api/tunnels\` \`{input}\` → 创建后返回隧道数组
- \`PATCH <base>/api/tunnels/{id}\` \`{input}\` → 更新后返回隧道数组
- \`DELETE <base>/api/tunnels/{id}\` → 删除后返回隧道数组
- \`POST <base>/api/tunnels/{id}/start\` → \`{forwardId, bindHost, bindPort}\`
- \`POST <base>/api/tunnels/{id}/stop\` → \`{success}\`

input: \`{name, sessionId, forwardType:"local"|"remote"|"dynamic", bindHost, bindPort, targetHost, targetPort}\`

**备份**
- \`GET <base>/api/backup/settings\` → 备份设置
- \`PUT <base>/api/backup/settings\` body: BackupSettings → 备份设置
- \`GET <base>/api/backup/records\` → 备份记录数组
- \`POST <base>/api/backup/run\` → 本次执行的结果数组
- \`DELETE <base>/api/backup/records/{id}?deleteFile=true\` → 剩余记录数组

## 规则

- 操作前先 \`POST /api/connect\`（幂等）。错误中含"未连接"时先调它再重试。它顺手开 SFTP，无需额外步骤。
- 未知主机密钥不会自动信任，\`/api/connect\` 会直接报错，由用户在 HelM 主窗口确认指纹。
- \`exec\` 默认 30s 超时；超时返回 \`exitStatus=124\` 加 \`timedOut=true\`。
- 危险命令（\`rm -rf /\`、\`shutdown\` 等）一律被拒绝，不要尝试规避。`;
}
