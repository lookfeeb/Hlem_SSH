# HelM

> 基于 **Tauri 2 + React 19 + Rust** 的现代 SSH / SFTP 桌面工作台

[![Windows Release](https://github.com/user/Helm/actions/workflows/release.yml/badge.svg)](https://github.com/user/Helm/actions/workflows/release.yml)
![Version](https://img.shields.io/badge/version-0.0.48-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20x64%20|%20x86%20|%20ARM64-green)

---

## 目录

- [项目概览](#项目概览)
- [系统架构总览](#系统架构总览)
- [技术栈](#技术栈)
- [后端模块架构](#后端模块架构)
- [前端组件架构](#前端组件架构)
- [SSH 连接生命周期](#ssh-连接生命周期)
- [数据流：终端命令](#数据流终端命令)
- [数据流：文件传输](#数据流文件传输)
- [端口转发架构](#端口转发架构)
- [安全架构](#安全架构)
- [AI API 本地网关](#ai-api-本地网关)
- [构建与发布流水线](#构建与发布流水线)
- [自动更新流程](#自动更新流程)
- [窗口与进程模型](#窗口与进程模型)
- [前端状态机](#前端状态机)
- [功能特性](#功能特性)
- [目录结构](#目录结构)
- [开发指南](#开发指南)

---

## 项目概览

HelM 是一款面向运维和开发人员的 **SSH / SFTP 桌面客户端**，集成终端、文件管理、端口转发、系统遥测、AI API 本地网关等功能于一体。单一可执行文件、原生窗口、零云端依赖，把多服务器运维所需的"终端 + 文件 + 转发 + 编辑 + 备份"收拢在一个加密工作区里。

---

## 系统架构总览

```mermaid
graph TB
    subgraph Desktop["HelM 桌面应用"]
        subgraph Frontend["前端 · WebView"]
            UI[React 19 + Ant Design 6]
            Terminal[xterm.js 终端]
            Editor[CodeMirror 编辑器]
            FM[文件管理器]
            Transfer[传输中心]
        end

        subgraph Backend["后端 · Rust Core"]
            TauriRT[Tauri 2 Runtime]
            CmdLayer[Commands IPC 层]
            RemoteMgr[Remote 连接管理器]
            VaultMgr[Vault 加密存储]
            APIServer[AI API REST Gateway]
            BackupEng[备份引擎]
        end

        subgraph SysService["系统服务"]
            Tray[系统托盘]
            AutoUpdate[自动更新]
            Logger[日志系统]
            Reaper[僵尸连接巡检]
        end
    end

    subgraph Remote["远程服务器"]
        SSH[SSH Server]
        SFTP[SFTP Subsystem]
        Shell[PTY Shell]
    end

    subgraph Cloud["云存储"]
        WebDAV[WebDAV]
        S3[AWS S3]
    end

    UI -->|Tauri IPC invoke| CmdLayer
    Terminal -->|terminal_write| CmdLayer
    CmdLayer --> RemoteMgr
    CmdLayer --> VaultMgr
    CmdLayer --> APIServer
    CmdLayer --> BackupEng
    RemoteMgr -->|russh| SSH
    RemoteMgr -->|russh-sftp| SFTP
    RemoteMgr -->|PTY Channel| Shell
    BackupEng -->|HTTPS| WebDAV
    BackupEng -->|SigV4| S3
    TauriRT --> Tray
    TauriRT --> Logger
    Reaper -.->|每30s| RemoteMgr
```

---

## 技术栈

```mermaid
graph LR
    subgraph FE["前端"]
        React[React 19]
        AntD[Ant Design 6]
        Xterm[xterm.js 6]
        CM[CodeMirror 6]
        Vite[Vite 8]
        TS[TypeScript 6]
    end

    subgraph BE["后端"]
        Rust[Rust 2021]
        Tauri[Tauri 2]
        Russh[russh 0.60]
        Axum[Axum 0.8]
        Tokio[Tokio]
        ChaCha[ChaCha20Poly1305]
    end

    subgraph CI["构建发布"]
        GHA[GitHub Actions]
        NSIS[NSIS Installer]
        LTO[Rust LTO]
    end
```

| 层级 | 技术 | 用途 |
|------|------|------|
| 框架 | Tauri 2 | 桌面应用壳、IPC、窗口管理、系统托盘 |
| 前端 | React 19 + TypeScript 6 | UI 组件与状态管理 |
| UI 库 | Ant Design 6 | 组件库 |
| 终端 | xterm.js 6 + WebGL Addon | 高性能终端渲染（失败自动回退） |
| 编辑器 | CodeMirror 6 | 远程文件编辑（JS/TS/Python/SQL/JSON/YAML/CSS/HTML） |
| 构建 | Vite 8 | 前端打包 |
| 后端 | Rust (Edition 2021) | 核心逻辑、异步 I/O |
| SSH | russh 0.60 | SSH2 协议实现 |
| SFTP | russh-sftp 2.1 | SFTP 子系统 |
| HTTP | Axum 0.8 + Tower-HTTP | AI API 本地 REST 网关 |
| 加密 | ChaCha20-Poly1305 + Argon2 | Vault 数据加密 |
| 异步 | Tokio (fs/io-util/net/sync/time) | 异步运行时 |
| 网络 | reqwest (rustls) | HTTPS 请求（更新/备份） |
| 安装 | NSIS | Windows 安装包 |

---

## 后端模块架构

```mermaid
graph TD
    subgraph Core["核心模块"]
        lib[lib.rs<br/>应用入口 + 托盘]
        main[main.rs<br/>程序入口]
        errors[errors.rs<br/>错误类型]
        events[events.rs<br/>事件总线]
    end

    subgraph Commands["commands/ — IPC 命令层"]
        cmd_remote[remote.rs<br/>连接/断开]
        cmd_sessions[sessions.rs<br/>会话CRUD]
        cmd_sftp[sftp.rs<br/>文件操作]
        cmd_terminal[terminal.rs<br/>终端读写]
        cmd_vault[vault.rs<br/>Vault操作]
        cmd_backup[backup.rs<br/>备份命令]
        cmd_desktop[desktop.rs<br/>桌面操作]
        cmd_api[api_server_cmd.rs<br/>API服务]
    end

    subgraph Remote["remote/ — 远端运行时"]
        lifecycle[lifecycle.rs<br/>连接生命周期]
        registry[runtime_registry.rs<br/>会话注册表]
        connection[runtime_connection.rs<br/>连接池]
        rt_terminal[runtime_terminal.rs<br/>PTY管理]
        rt_sftp[runtime_sftp.rs<br/>SFTP运行时]
        rt_transfer[runtime_transfer.rs<br/>传输调度]
        rt_forward[runtime_forward.rs<br/>端口转发]
        rt_telemetry[runtime_telemetry.rs<br/>遥测采集]
        ssh[ssh.rs<br/>SSH客户端]
        sftp[sftp.rs<br/>SFTP底层]
        transfer[transfer.rs<br/>传输引擎]
        telemetry[telemetry.rs<br/>指标解析]
        proxy[proxy.rs<br/>代理拨号]
        emitters[event_emitters.rs<br/>事件发射]
    end

    subgraph Storage["存储与安全"]
        vault[vault.rs<br/>加密工作区]
        crypto[crypto.rs<br/>密码学原语]
        config[config.rs<br/>配置管理]
        backup[backup.rs<br/>备份引擎]
    end

    subgraph API["api_server/ — AI API 本地网关"]
        api_mod[mod.rs<br/>Axum路由]
        auth[auth.rs<br/>Bearer鉴权]
        guard[guard.rs<br/>命令安全守卫]
        handlers_remote[handlers_remote.rs<br/>会话/命令/文件]
        handlers_admin[handlers_admin.rs<br/>隧道/备份]
        handlers_jobs[handlers_jobs.rs<br/>长任务/SSE]
        jobs[jobs.rs<br/>任务状态与取消]
        catalog[field_catalog.rs<br/>动态字段库]
        openapi[openapi.rs<br/>OpenAPI 3.1]
    end

    lib --> Commands
    Commands --> Remote
    Commands --> Storage
    Commands --> API
    vault --> crypto
    lifecycle --> ssh
    lifecycle --> sftp
    ssh --> proxy
    rt_transfer --> transfer
    rt_telemetry --> telemetry
    registry --> connection
```

---

## 前端组件架构

```mermaid
graph TD
    subgraph Entry["入口"]
        main_tsx[main.tsx]
        App[App.tsx<br/>主状态容器 ~1800行]
    end

    subgraph Layout["布局组件"]
        TopBar[TopBar<br/>标签栏+工具栏]
        SplitPane[SplitPane<br/>可拖拽分屏]
        TelemetrySidebar[TelemetrySidebar<br/>系统监控侧栏]
    end

    subgraph Workspace["工作区组件"]
        TerminalPanel[TerminalPanel<br/>xterm.js终端]
        FileManager[FileManager<br/>SFTP文件管理器]
        CodeEditor[CodeEditor<br/>CodeMirror远程编辑]
        TransferCenter[TransferCenter<br/>传输中心]
    end

    subgraph Modals["弹窗/抽屉"]
        SessionConfig[SessionConfigModal<br/>会话配置]
        Settings[SettingsModal<br/>全局设置+更新]
        BackupModal[BackupModal<br/>备份管理]
        TunnelDrawer[TunnelDrawer<br/>隧道管理]
        MigrationGate[MigrationGate<br/>数据迁移]
    end

    subgraph APILayer["API 层"]
        appApi[appApi.ts<br/>应用API]
        remoteApi[remoteApi.ts<br/>远程操作API]
        vaultApi[vaultApi.ts<br/>Vault API]
        appEvents[appEvents.ts<br/>事件监听]
    end

    subgraph Lib["工具库"]
        path[path.ts<br/>远程路径]
        configMapping[configMapping.ts<br/>配置映射]
        editorChannel[editorChannel.ts<br/>编辑器BroadcastChannel]
        fileClassify[fileClassify.ts<br/>文件类型识别]
        format[format.ts<br/>格式化]
    end

    main_tsx --> App
    App --> TopBar
    App --> SplitPane
    SplitPane --> TerminalPanel
    SplitPane --> FileManager
    App --> TelemetrySidebar
    App --> TransferCenter
    App --> SessionConfig
    App --> Settings
    App --> BackupModal
    App --> TunnelDrawer
    App --> MigrationGate
    FileManager --> CodeEditor
    App --> APILayer
    Workspace --> Lib
```

---

## SSH 连接生命周期

```mermaid
sequenceDiagram
    participant UI as 前端 UI
    participant Cmd as Commands 层
    participant Remote as Remote 管理器
    participant SSH as russh Client
    participant Server as 远程服务器

    UI->>Cmd: ssh_connect(session_id)
    Cmd->>Remote: connect(config)
    Remote->>SSH: TCP 连接 (可经 proxy)
    SSH->>Server: SSH 握手

    alt 新主机密钥
        Server-->>SSH: 未知主机密钥
        SSH-->>UI: host_key_verify 事件
        UI->>UI: 弹窗确认指纹
        UI->>Cmd: ssh_trust_host_key()
        Cmd->>Remote: 信任并重连
    end

    SSH->>Server: 用户认证 (密码/私钥)
    Server-->>SSH: 认证成功
    Remote-->>UI: ConnectionId

    par 并行初始化
        UI->>Cmd: terminal_open(conn_id)
        Cmd->>Remote: 请求 PTY Channel
        Remote->>Server: channel_open + pty_request + shell
        Server-->>UI: TerminalId ✓
    and
        UI->>Cmd: sftp_open(conn_id)
        Cmd->>Remote: 请求 SFTP Subsystem
        Remote->>Server: subsystem "sftp"
        Server-->>UI: SftpId ✓
    and
        UI->>Cmd: telemetry_start(conn_id)
        Cmd->>Remote: 启动遥测采集(5s间隔)
        Remote-->>UI: TelemetryJobId ✓
    end
```

---

## 数据流：终端命令

```mermaid
sequenceDiagram
    participant User as 用户键盘
    participant Xterm as xterm.js
    participant IPC as Tauri IPC
    participant Cmd as terminal_write
    participant Registry as runtime_registry
    participant Channel as russh Channel
    participant Server as 远程 sshd

    User->>Xterm: 键入字符
    Xterm->>IPC: invoke("terminal_write", data)
    IPC->>Cmd: terminal_write(terminal_id, data)
    Cmd->>Registry: 查找 terminal_id → Channel
    Registry-->>Cmd: Channel handle
    Cmd->>Channel: write(bytes)
    Channel->>Server: SSH 加密传输
    Server-->>Channel: stdout 响应
    Channel-->>Registry: 异步读取协程
    Registry->>IPC: emit("terminal://data", payload)
    IPC->>Xterm: listen 回调写入
    Xterm->>User: 渲染输出
```

> 每会话一对独立的读写 Tokio 任务，跨会话不互相阻塞。前端通过 `requestAnimationFrame` 批量刷新终端输出，避免高频事件导致 UI 卡顿。

---

## 数据流：文件传输

```mermaid
sequenceDiagram
    participant UI as 文件管理器
    participant App as App 状态
    participant API as remoteApi
    participant Rust as Transfer Engine
    participant SFTP as SFTP Channel
    participant Server as 远程文件系统

    UI->>App: uploadLocalFiles(paths, dir)
    App->>API: expandLocalPaths(paths)
    API-->>App: 展开文件列表(含相对路径)

    loop 创建远程目录结构
        App->>API: mkdir(sftpId, dir)
    end

    par 并发上传队列
        App->>API: upload(sftpId, local, remote)
        API->>Rust: transfer_upload command
        Rust->>SFTP: 分块写入
        SFTP->>Server: SFTP WRITE
        Server-->>SFTP: ACK
        Rust-->>App: TransferProgress 事件
        App->>UI: 更新进度条
    end

    Rust-->>App: TransferCompleted 事件
    App->>API: listFiles(sftpId, dir)
    API-->>App: 刷新文件列表
    App->>UI: 更新文件视图
```

> 单文件上传走单连接 + 大缓冲（accelerated）；多文件走并发 + 普通缓冲，避免内存峰值。

---

## 端口转发架构

```mermaid
graph TD
    subgraph LocalForward["本地转发 (-L)"]
        LA[本地应用] -->|bind_host:bind_port| LH[HelM 监听]
        LH -->|SSH Channel| RS1[远程 target_host:target_port]
    end

    subgraph RemoteForward["远程转发 (-R)"]
        RA[远程应用] -->|bind_host:bind_port| RH[远程 sshd 监听]
        RH -->|SSH Channel| LS1[本地 target_host:target_port]
    end

    subgraph DynamicForward["动态转发 (-D)"]
        DA[本地应用] -->|SOCKS5| DH[HelM SOCKS 代理]
        DH -->|SSH Channel| ANY[远程任意目标]
    end
```

```mermaid
sequenceDiagram
    participant App as 本地应用
    participant HelM as HelM (forward模块)
    participant SSH as SSH Channel
    participant Target as 远程目标

    Note over App,Target: 本地转发示例
    App->>HelM: TCP connect(bind_host:bind_port)
    HelM->>SSH: direct-tcpip(target_host:target_port)
    SSH->>Target: TCP connect
    Target-->>SSH: 数据
    SSH-->>HelM: 数据
    HelM-->>App: 数据
```

---

## 安全架构

```mermaid
graph TD
    subgraph KeyDerivation["密钥派生"]
        Password[用户主密码] -->|Argon2id| DerivedKey[派生密钥]
        DerivedKey -->|加密| DataKey[数据密钥]
    end

    subgraph Encryption["数据加密"]
        DataKey -->|ChaCha20-Poly1305| Ciphertext[密文]
        Salt[随机 Salt] --> Ciphertext
        Nonce[随机 Nonce] --> Ciphertext
        Ciphertext -->|写入| Disk[(vault.rpvault)]
    end

    subgraph Runtime["运行时安全"]
        Disk -->|解密| Memory[内存明文 VaultData]
        Memory -->|zeroize| Zero[进程退出清零]
        Memory -->|提供给| Business[业务模块]
    end

    subgraph Backup["备份安全"]
        Disk -->|不解密直接zip| BackupPkg[加密备份包]
        BackupPkg --> LocalDir[本地目录]
        BackupPkg --> CloudStore[WebDAV / S3]
    end
```

### 密钥与算法一览

| 组件 | 算法 | 用途 |
|------|------|------|
| Vault 主密钥 | Argon2id (内存硬度) | 从用户密码派生加密密钥 |
| 数据加密 | ChaCha20-Poly1305 (AEAD) | 加密会话配置、凭据、私钥 |
| API 鉴权 | Bearer API Key + 会话白名单 | 本机 REST 请求鉴权与授权范围限制 |
| 更新签名 | RSA-PSS (SHA256, salt=32) | 验证安装包完整性 |
| 内存安全 | zeroize crate | 敏感数据使用后立即清零 |
| 传输安全 | SSH2 加密通道 | 所有远程通信端到端加密 |

### 安全关键性质

- 主密码**只在内存停留**，不持久化、不上送远端
- 派生密钥不离开 Rust 进程，前端只能拿到解密后的业务数据
- 备份包传上公共云盘**不暴露明文**——攻击者拿到也只是等长密文
- known-hosts 指纹纳入 vault，远端被 MITM 时本地立即觉察
- 前端表单禁用浏览器自动填充，凭据不留痕到 WebView 历史

---

## AI API 本地网关

HelM 的 AI API **不是模型推理接口**，而是面向本机 AI 助手、脚本和自动化工具的 SSH / SFTP REST 网关。服务运行在 Rust 主进程中，仅绑定 `127.0.0.1`，通过用户明确授权的 HelM 会话连接远端服务器。

### 启用与调用

1. 在设置中打开 **AI API 控制**。
2. 选择 1–20 个允许 API 访问的 SSH 会话，设置监听端口（默认 `19880`）。
3. 启动服务；如需每次启动 HelM 后自动恢复，可开启 **随应用自动启动**。
4. 使用控制面板显示的 API 地址和 API Key 调用接口；所有请求都需要 `Authorization: Bearer <api_key>`。
5. 首次接入可读取 `GET /openapi.json`（标准 OpenAPI 3.1）或 `GET /api/fields`（HelM 动态字段库）。
6. 服务运行后也可直接点击 **接口调试**，在内置调试台选择端点、会话并执行请求；普通请求与 SSE 实时订阅都可在窗口内查看，也可复制 PowerShell cURL。

```powershell
$helmApiKey = "<api_key>"
$helmHeaders = @{ Authorization = "Bearer $helmApiKey" }

# 读取动态字段库
Invoke-RestMethod `
  -Headers $helmHeaders `
  -Uri "http://127.0.0.1:19880/api/fields"

# 自动连接指定会话并执行命令
$helmBody = @{
  sessionId = "<session_id>"
  command = "uname -a"
  safetyMode = "balanced"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Headers $helmHeaders `
  -ContentType "application/json" `
  -Body $helmBody `
  -Uri "http://127.0.0.1:19880/api/exec"

# 创建长任务；适合部署、构建、日志跟踪等耗时命令
$helmJobBody = @{
  sessionId = "<session_id>"
  command = "docker compose pull && docker compose up -d"
  timeoutMs = 1800000
} | ConvertTo-Json

$helmJob = Invoke-RestMethod `
  -Method Post `
  -Headers $helmHeaders `
  -ContentType "application/json" `
  -Body $helmJobBody `
  -Uri "http://127.0.0.1:19880/api/jobs"

# 实时订阅 stdout/stderr；断线后可附加 Last-Event-ID 续传
curl.exe -N `
  -H "Authorization: Bearer $helmApiKey" `
  -H "Accept: text/event-stream" `
  "http://127.0.0.1:19880/api/jobs/$($helmJob.jobId)/events"

# 查询状态或请求取消
Invoke-RestMethod -Headers $helmHeaders `
  -Uri "http://127.0.0.1:19880/api/jobs/$($helmJob.jobId)"

Invoke-RestMethod -Method Post -Headers $helmHeaders `
  -Uri "http://127.0.0.1:19880/api/jobs/$($helmJob.jobId)/cancel"
```

### 字段库、选择规则与缓存

`GET /api/fields` v10 一次返回 31 个端点、51 个 Schema、18 条端点/字段选择规则和 15 个结构化调用示例。`/api/fields` 与 `/openapi.json` 均返回 `ETag`；调用方缓存正文后发送 `If-None-Match`，内容未变化时会收到无正文的 `304`，不需要每执行一条命令就重新下载文档。

- `selectionRules` 说明何时选择 `exec`、`exec/batch`、`jobs`、文件全量/分页/元数据端点，以及隧道和备份的 PUT/PATCH 语义。
- `examples` 使用 `method`、`path`、`query`、`headers`、`body` 表达请求，不重复全局鉴权头，可直接转换为 HTTP 请求。
- 只做鉴权探活时读取 `/api/auth`；需要标准生态兼容时读取 `/openapi.json`。

```powershell
# 原子上传完整文件；可选 SHA-256 校验，不支持 Content-Range
$uploadFile = "C:\Temp\helm-upload.bin"
$uploadSha256 = (Get-FileHash -Algorithm SHA256 $uploadFile).Hash.ToLowerInvariant()
curl.exe -X PUT `
  -H "Authorization: Bearer $helmApiKey" `
  -H "Content-Type: application/octet-stream" `
  --data-binary "@$uploadFile" `
  "http://127.0.0.1:19880/api/upload?sessionId=<session_id>&remotePath=%2Ftmp%2Fhelm-upload.bin&sha256=$uploadSha256"

# 只下载前 1 MiB
curl.exe `
  -H "Authorization: Bearer $helmApiKey" `
  -H "Range: bytes=0-1048575" `
  -o "C:\Temp\syslog.part" `
  "http://127.0.0.1:19880/api/download?sessionId=<session_id>&path=%2Fvar%2Flog%2Fsyslog"
```

### OpenAPI 与接口调试台

- `GET /openapi.json` 返回 OpenAPI 3.1 文档，由 `/api/fields` 同一份字段目录动态生成，并通过 `x-helm-selection-rules`、`x-helm-examples` 携带相同规则和示例。
- `/api/auth` 的端点目录直接由字段库生成，并返回 `fieldCatalogVersion` 与本次进程的 `serverInstanceId`；不会再单独维护第二份端点清单。
- 内置调试台会读取该文档，自动生成路径参数、查询参数、JSON 请求体和已授权会话示例，并显示状态码、耗时、响应头及响应体。JSON 响应会自动格式化并按键、字符串、数字、布尔值和空值着色，输出框聚焦或悬浮时可一键复制结构化结果。
- 创建任务后，调试台会记住最新 `jobId`，切换到查询、取消或 SSE 端点时自动填入。SSE 可直接在窗口内开始或停止订阅，实时汇总事件并显示事件数；“复制 cURL”仍会生成带 `curl.exe -N` 的独立订阅命令。

### 当前能力

| 类别 | 端点 | 能力 |
|------|------|------|
| 元信息 | `/api/auth`、`/api/fields`、`/openapi.json` | 鉴权探活、动态字段库、ETag 缓存和 OpenAPI 3.1 文档 |
| 会话 | `/api/sessions`、`/api/connect`、`/api/disconnect` | 查询连接 ID、状态和建立时间，幂等连接会返回 `reused` |
| 命令 | `/api/exec`、`/api/exec/batch` | 单条或批量执行命令，支持安全模式、超时、输出截断标记和最多 4 路并行 |
| 长任务 | `/api/jobs...` | 创建、摘要列表、状态与输出查询、SSE 实时输出和取消 |
| 诊断 | `/api/latency` | 通过 SSH 原生 ping 采集延迟、中位数和抖动 |
| 文件 | `/api/files...`、`/api/upload`、`/api/download` | 全量/游标分页目录、单路径元数据、SHA-256 原子上传和单段 Range 下载 |
| 隧道 | `/api/tunnels...` | 隧道配置查询、创建、局部 PATCH、删除、启动和停止 |
| 备份 | `/api/backup...` | 设置完整 PUT 或 JSON Merge PATCH、执行备份、查询及删除记录 |

字段库 v10 共描述 31 个 HTTP 端点和 51 个 Schema。`exec`、`exec/batch`、`jobs`、`latency`、`files`、`upload` 和 `download` 会自动建立并复用 SSH / SFTP；`/api/connect` 仅用于主动预热或单独检查连接。连续短命令会复用连接并预热 SSH 执行通道，超时、取消或本地中止会终止已跟踪的远端进程组。

`exec`、`exec/batch` 与长任务共用执行配额：每个会话最多 4 条、全局最多 16 条命令同时运行，队列等待超过 3 秒会返回 `429` 或将任务标记为失败。会话授权使用内存哈希索引，配置提交时同步刷新；AI API 的 `stdout`、`stderr` 各保留尾部 1 MiB，并通过 `stdoutBytes`、`stderrBytes`、`outputTruncated` 返回原始大小和截断状态。`ExecResult` 还返回 `durationMs`、`queueMs`、`connectionMs`、`channelOpenMs` 和 `executionMs`，用于区分端到端、排队、冷连接、通道创建与命令执行耗时。

长任务默认超时 30 分钟、最长 24 小时，创建记录后立即返回 `202`；SSH 连接和执行队列阶段也能取消。任务状态包含 `connecting`，快照与摘要返回 `queueMs`、`connectionMs`、`channelOpenMs`、`executionMs` 和 `durationMs`。`GET /api/jobs` 只返回不含正文的摘要，完整输出通过 `GET /api/jobs/{job_id}` 查询。每个任务的 SSE 历史同时受 1024 条事件和 4 MiB 字节预算限制；结束后的任务记录保留 30 分钟。

所有 JSON 错误响应保留兼容字段 `error`，并增加 `code`、`message`、`retryable` 与 `requestId`。下载仅接受单段 `Range`：语法错误返回 `400`，多段或越界返回 `416`；不会再退化为完整文件的 `200` 响应。

### 安全边界

- 服务只监听本机回环地址，CORS 仅允许本机来源，不直接向局域网或公网暴露。
- API Key 是整个本地 API 的全权令牌；会话类操作还会额外受会话白名单限制，密钥泄露后应立即在控制面板重新生成。
- 会话白名单可在运行中热更新；清空授权会话会立即停止 API 服务。
- 命令默认使用 `balanced` 安全模式，也可使用限制更严格的 `strict` 模式。
- 未知主机密钥不会被 API 自动信任，必须在 HelM 主窗口确认服务器指纹。
- API 操作日志会对常见令牌、密码、认证头、私钥和凭据内容进行脱敏。

---

## 构建与发布流水线

```mermaid
graph LR
    subgraph Trigger["触发条件"]
        Push[push to main/master]
        Manual[workflow_dispatch<br/>可指定版本号]
    end

    subgraph Version["版本计算"]
        Compute[读取 package.json<br/>或使用手动输入]
    end

    subgraph Build["并行构建 (windows-latest)"]
        X64[win-x64<br/>x86_64-pc-windows-msvc]
        X86[win-x86<br/>i686-pc-windows-msvc]
        ARM64[win-arm64<br/>aarch64-pc-windows-msvc]
    end

    subgraph Release["发布"]
        Sign[RSA-PSS 签名<br/>生成 latest.json + .sig]
        SHA[SHA256SUMS.txt]
        Notes[自动生成 Release Notes]
        Tag[创建 Git Tag]
        GHRelease[GitHub Release]
    end

    Push --> Compute
    Manual --> Compute
    Compute --> X64
    Compute --> X86
    Compute --> ARM64
    X64 --> Sign
    X86 --> Sign
    ARM64 --> Sign
    Sign --> SHA
    SHA --> Notes
    Notes --> Tag
    Tag --> GHRelease
```

### 构建优化

- **Rust LTO** (thin) — 减小二进制体积
- **codegen-units = 1** — 最大化优化
- **strip = symbols** — 去除调试符号
- **Rust Cache** — Swatinem/rust-cache 加速 CI
- **npm cache** — Node 依赖缓存

---

## 自动更新流程

```mermaid
sequenceDiagram
    participant App as HelM 客户端
    participant GH as GitHub Releases
    participant User as 用户

    App->>GH: GET latest.json
    App->>GH: GET latest.json.sig
    App->>App: RSA-PSS 验签 (公钥编译时嵌入)
    App->>App: 比较 appVersion vs 当前版本

    alt 有新版本
        App->>User: 弹窗提示新版本 + 更新内容
        User->>App: 确认下载
        App->>GH: 下载对应架构 .exe
        App->>App: SHA256 校验
        App->>App: 停止接收 API 请求并取消长任务
        App->>App: 等待 AI API 监听端口与 SSH 资源释放
        App->>User: 退出当前进程并启动 NSIS 安装程序
    else 已是最新
        App->>App: 静默跳过
    end
```

更新辅助进程只等待当前 HelM PID 退出，不会按进程名强制结束其他实例。安装程序在旧进程退出、AI API 端口释放后才执行并重启新版本，避免重启后端口仍被占用。

---

## 窗口与进程模型

```mermaid
graph TD
    subgraph Process["Rust 主进程 (单实例)"]
        TokioRT[Tokio Runtime]
        AllConnections[所有 SSH 连接]
        TrayService[托盘服务]
    end

    subgraph Windows["WebView 窗口"]
        Splash[splash<br/>360×220 无边框<br/>启动画面]
        Main[main<br/>1365×900<br/>主工作区]
        EditorWin[editor<br/>独立编辑器窗口<br/>可拖到副屏]
    end

    Splash -->|frontend_ready 事件| Main
    Main -->|BroadcastChannel| EditorWin
    Main -->|关闭 → 隐藏到托盘| TrayService
    TrayService -->|双击图标| Main
    TrayService -->|菜单: 退出| Process

    Process -.->|进程存活 = 连接保持| AllConnections
```

### 窗口行为

| 窗口 | 尺寸 | 特性 |
|------|------|------|
| splash | 360×220 | 无边框、居中、透明背景、启动后自动关闭 |
| main | 1365×900 | 可调大小、关闭=隐藏到托盘、标题栏自定义 |
| editor | 按需创建 | 独立窗口、BroadcastChannel 与主窗口通信 |

---

## 前端状态机

```mermaid
stateDiagram-v2
    [*] --> Splash: 应用启动
    Splash --> VaultGate: 主窗口加载
    VaultGate --> MigrationCheck: 主密码验证通过
    MigrationCheck --> MigrationGate: 需要数据迁移
    MigrationCheck --> Ready: 无需迁移
    MigrationGate --> Ready: 迁移完成
    Ready --> SessionList: 显示会话列表

    state SessionWorkspace {
        [*] --> Disconnected
        Disconnected --> Connecting: connectSession()
        Connecting --> Connected: SSH 握手成功
        Connecting --> HostKeyVerify: 未知主机密钥
        HostKeyVerify --> Connecting: 用户信任
        HostKeyVerify --> Disconnected: 用户拒绝
        Connecting --> Failed: 连接失败/认证失败
        Failed --> Connecting: 重试
        Connected --> Disconnected: disconnect()
        Connected --> Disconnected: 连接断开(事件)
        Connected --> Disconnected: 僵尸巡检清理
    }

    SessionList --> SessionWorkspace: 双击会话
    SessionWorkspace --> SessionList: 关闭标签
```

---

## 功能特性

```mermaid
mindmap
  root((HelM))
    SSH 终端
      多会话标签页并行
      xterm.js + WebGL 渲染
      常用命令面板(按频率排序)
      PTY 自适应大小
      Keepalive 心跳防断线
    SFTP 文件管理
      类资源管理器布局
      面包屑路径导航
      拖拽上传/下载
      并发传输队列
      安全临时文件传输与失败重试
      远程文件在线编辑
      隐藏文件切换
    端口转发
      本地转发 -L
      远程转发 -R
      动态转发 -D SOCKS5
      隧道持久化配置
      实时状态可视化
    系统监控
      CPU / 内存 / 磁盘
      网络流量
      进程列表
      5s 实时刷新
    安全存储
      Vault 主密码加密
      Argon2id + ChaCha20
      一键锁定工作区
      零留痕设计
    备份系统
      本地目录备份
      WebDAV 云备份
      S3 SigV4 云备份
      定时自动备份
      保留策略自动清理
      加密形态导出
    AI API 本地网关
      127.0.0.1 HTTP REST
      Bearer API Key + 会话白名单
      31 个端点与动态字段库
      OpenAPI 3.1 + 内置调试台
      长任务 SSE 实时输出与取消
      SSH/SFTP 自动连接复用
      自动启动
    系统集成
      系统托盘(双击恢复)
      开机自启
      自动更新(RSA验签)
      三架构支持 x64/x86/ARM64
```

### 终端与会话

- **多会话并行** — 同时运行任意数量 SSH 会话，互不阻塞；会话级独立 Tokio 任务
- **会话分组** — 按生产/测试/客户等维度归类，分组保存于加密工作区
- **真终端体验** — xterm.js + addon-fit 自适应；支持 Ctrl+C / vim / top 等交互式程序
- **常用命令面板** — `quick_commands` 集中管理、搜索并一键发送到当前终端
- **断线重连与心跳** — keepalive 配合指数退避自动重连，支持手动断开后禁止自动重连
- **僵尸连接巡检** — 每 30s 检测并清理已断开的连接

### 文件管理（SFTP）

- **远程文件浏览器** — 类资源管理器布局，双击进入、面包屑路径、隐藏文件切换
- **拖拽上传/下载** — 操作系统拖拽与右键菜单双通道
- **传输中心** — 多任务并发、单独取消、失败重试，进度可视化
- **安全传输** — 先写临时文件，完成后校验并原子替换，失败不会破坏目标文件
- **低资源策略** — 非活动会话自动降低遥测频率，终端固定 5000 行回滚并支持 WebGL 回退
- **远程编辑** — 双击远端文件 → 独立 CodeMirror 子窗口 → 保存自动回写远端
- **文件搜索** — 远程目录内文件名搜索

### 端口转发与代理

- **三种转发模式** — 本地(-L) / 远程(-R) / 动态(-D, SOCKS) 一站式配置
- **转发可视化** — 隧道抽屉实时显示绑定端口、目标、状态；启停在 UI 内完成
- **出站代理** — 全局或会话级 SOCKS5 / HTTP CONNECT，便于跨内网访问

### 系统遥测

- **远端指标侧边栏** — CPU、内存、网络、磁盘实时折线图
- **无需额外 agent** — 后端通过 SSH exec 定时采样推送，无需在远端安装任何软件

### AI API 本地网关

- **本机 REST 自动化** — 仅监听 `127.0.0.1`，供本机 AI 助手、脚本和自动化工具调用
- **动态字段库** — `/api/fields` v10 一次返回端点、Schema、约束、选择规则和结构化示例，可按版本或 ETag 缓存
- **标准规范与调试** — `/openapi.json` 提供 OpenAPI 3.1，内置调试台可直接生成并执行请求
- **可控长任务** — 任务状态查询、SSE 实时 stdout/stderr、断线续传、超时和取消
- **会话授权范围** — 最多选择 20 个可访问会话，运行中可热更新并立即生效
- **自动连接复用** — 命令、诊断和文件操作按需拉起并复用 SSH / SFTP 连接
- **安全与审计** — Bearer API Key、命令危险模式拦截、主机指纹确认和脱敏操作日志

### 安全与备份

- **主密码加密工作区** — 启动需输入主密码解锁；离开座位可一键锁定
- **零留痕** — 主密码不持久化、不上送远端；凭据仅以 ChaCha20-Poly1305 密文存于本地
- **三通道备份** — 本地目录 / WebDAV / S3 任选；可定时自动备份
- **保留策略** — 按"份数 + 天数"双维度自动清理旧备份
- **加密形态导出** — 导出的备份本身就是密文，传上云盘也无法离线破解

### 备份覆盖范围

| 类别 | 内容 |
|------|------|
| 会话 | 名称、分组、主机、端口、用户名、密码/私钥/passphrase |
| 终端 | 编码、主题、keepalive 间隔 |
| SFTP | 默认路径、是否显示隐藏文件 |
| 代理 | 单会话 SOCKS5 / HTTP CONNECT 配置 |
| 分组 | 自定义分组结构与排序 |
| 端口转发 | 全部已保存的本地/远程/动态隧道 |
| 全局代理 | AppSettings.proxy 出站代理 |
| 常用命令 | quick_commands 命令列表 |
| 已信任主机 | known-hosts 指纹列表 |
| 备份配置 | 本地目录、WebDAV/S3 凭据、保留策略、自动备份频率 |
| 历史记录 | backup_records 备份日志 |

> **一句话：所有需要你重新配的东西，都在备份里。** 换机只需安装 + 输入主密码 + 恢复备份即可继续工作。

---

## 目录结构

```
Helm/
├── src/                            # React 前端源码
│   ├── api/                        # Tauri IPC 命令封装
│   │   ├── remoteApi.ts            # 远端会话/SFTP/转发/遥测
│   │   ├── vaultApi.ts             # 加密工作区操作
│   │   ├── appApi.ts               # 应用级操作(更新/备份/设置)
│   │   ├── appEvents.ts            # 事件订阅(终端数据/传输进度/遥测)
│   │   └── runtime.ts              # 运行时工具
│   ├── app/                        # 应用入口、主题、懒加载
│   ├── components/                 # UI 组件
│   │   ├── TopBar.tsx              # 标签栏 + 工具栏
│   │   ├── TerminalPanel.tsx       # xterm.js 终端面板
│   │   ├── FileManager.tsx         # SFTP 文件管理器
│   │   ├── TransferCenter.tsx      # 传输中心(上传/下载/续传)
│   │   ├── TunnelDrawer.tsx        # 端口转发抽屉
│   │   ├── TelemetrySidebar.tsx    # 系统监控侧边栏
│   │   ├── BackupModal.tsx         # 备份/恢复弹窗
│   │   ├── SettingsModal.tsx       # 全局设置 + 自动更新
│   │   ├── settings/
│   │   │   └── ApiExplorerModal.tsx # OpenAPI 接口调试台
│   │   ├── SessionConfigModal.tsx  # 会话配置弹窗
│   │   ├── CodeEditor.tsx          # CodeMirror 远程编辑器
│   │   ├── EditorWindowApp.tsx     # 编辑器子窗口入口
│   │   ├── VaultGate.tsx           # 主密码解锁门
│   │   ├── MigrationGate.tsx       # 数据迁移门
│   │   └── shared/                 # 共享子组件
│   ├── lib/                        # 工具函数
│   │   ├── path.ts                 # 远程路径处理
│   │   ├── configMapping.ts        # 配置映射
│   │   ├── editorChannel.ts        # 编辑器 BroadcastChannel
│   │   ├── fileClassify.ts         # 文件类型识别
│   │   ├── format.ts              # 格式化工具
│   │   ├── apiExplorer.ts          # OpenAPI 解析、示例请求与 cURL 生成
│   │   └── clipboard.ts           # 剪贴板
│   ├── styles/                     # 模块化 CSS
│   │   ├── tokens.css             # 设计令牌
│   │   ├── layout.css             # 布局
│   │   └── modals.css             # 弹窗样式
│   └── types.ts                    # 共享 TypeScript 类型
├── src-tauri/                      # Rust 后端源码
│   ├── src/
│   │   ├── remote/                 # 远端运行时(按职能拆分)
│   │   │   ├── mod.rs              # 模块导出
│   │   │   ├── lifecycle.rs        # 连接生命周期管理
│   │   │   ├── runtime_registry.rs # 会话注册表
│   │   │   ├── runtime_connection.rs # 连接运行时
│   │   │   ├── runtime_terminal.rs # PTY 终端管理
│   │   │   ├── runtime_sftp.rs     # SFTP 运行时
│   │   │   ├── runtime_transfer.rs # 传输调度
│   │   │   ├── runtime_forward.rs  # 端口转发运行时
│   │   │   ├── runtime_telemetry.rs # 遥测采集
│   │   │   ├── ssh.rs             # SSH 客户端封装
│   │   │   ├── sftp.rs            # SFTP 底层操作
│   │   │   ├── transfer.rs        # 传输引擎(分块/续传)
│   │   │   ├── telemetry.rs       # 指标解析
│   │   │   ├── proxy.rs           # SOCKS5/HTTP CONNECT 代理
│   │   │   └── event_emitters.rs  # 事件发射器
│   │   ├── commands/               # Tauri IPC 命令(按领域拆分)
│   │   │   ├── mod.rs
│   │   │   ├── remote.rs          # 连接/断开
│   │   │   ├── sessions.rs        # 会话 CRUD
│   │   │   ├── sftp.rs            # 文件操作
│   │   │   ├── terminal.rs        # 终端读写
│   │   │   ├── vault.rs           # Vault 操作
│   │   │   ├── backup.rs          # 备份命令
│   │   │   ├── desktop.rs         # 桌面操作
│   │   │   └── api_server_cmd.rs  # API 服务命令
│   │   ├── api_server/             # AI API 本地 REST 网关
│   │   │   ├── mod.rs             # Axum 路由、CORS 与操作日志
│   │   │   ├── auth.rs            # Bearer 鉴权与会话访问校验
│   │   │   ├── guard.rs           # 危险命令安全守卫
│   │   │   ├── field_catalog.rs   # 动态端点与字段库
│   │   │   ├── openapi.rs          # OpenAPI 3.1 文档生成
│   │   │   ├── jobs.rs             # 长任务注册表、事件历史与取消
│   │   │   ├── handlers_jobs.rs    # 任务 REST 与 SSE 接口
│   │   │   ├── handlers_remote.rs # 会话、命令与文件接口
│   │   │   └── handlers_admin.rs  # 隧道与备份接口
│   │   ├── vault.rs               # 加密工作区(Argon2+ChaCha20)
│   │   ├── crypto.rs              # 密码学原语
│   │   ├── backup.rs              # 本地/WebDAV/S3 备份引擎
│   │   ├── config.rs              # 配置管理(serde + 向后兼容)
│   │   ├── events.rs              # 前后端事件总线
│   │   ├── errors.rs              # 错误类型定义
│   │   ├── lib.rs                 # 应用入口 + 托盘 + 插件注册
│   │   └── main.rs               # 程序入口
│   ├── capabilities/               # Tauri 权限清单
│   ├── icons/                      # 应用图标(多尺寸)
│   └── tauri.conf.json            # Tauri 配置
├── tools/free-port/                # 启动前清理 1420 端口的小工具
│   ├── src/main.rs
│   └── Cargo.toml
├── tests/                          # Playwright E2E 测试
├── .github/workflows/              # CI/CD 流水线
│   └── release.yml                # 三架构并行构建 + 发布
├── build.ps1                       # Windows 交互式编译脚本
├── playwright.config.ts            # E2E 测试配置
├── vite.config.ts                  # Vite 构建配置
├── tsconfig.json                   # TypeScript 配置
└── package.json                    # 前端依赖 + 脚本
```

---

## 开发指南

### 前置要求

- Node.js >= 18
- Rust stable (需 `cargo`)
- npm (或 pnpm / yarn)
- Windows: WebView2 Runtime (Win10+ 已内置)

### 启动开发服务器

```powershell
# 安装依赖
npm install

# 启动开发模式（Vite 热重载 + Rust 增量编译）
# 启动前自动调用 tools/free-port 释放 1420 端口
npm run tauri:dev
```

### 生产编译

```powershell
# 交互式脚本（推荐）— 可选 LTO/普通/清理
.\build.ps1

# 或直接调用
npm run tauri:build
```

### 端到端测试

```powershell
npm run test:e2e
```

### build.ps1 选项

| 选项 | 说明 |
|------|------|
| LTO 编译 | 体积更小，编译更慢 (thin LTO + codegen-units=1) |
| 普通编译 | 速度快，适合日常开发 |
| 清理缓存 | 清理 cargo target / free-port target / dist / .vite / test-results |

---

## License

MIT
