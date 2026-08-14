use super::*;

pub(super) enum PreparedAuthentication {
    Password(String),
    PrivateKey(Arc<ssh_key::PrivateKey>),
}

impl PreparedAuthentication {
    pub(super) fn label(&self) -> &'static str {
        match self {
            Self::Password(_) => "password",
            Self::PrivateKey(key) if key.algorithm().is_rsa() => "publickey-rsa",
            Self::PrivateKey(_) => "publickey",
        }
    }
}

pub(super) enum AuthenticationPreparation {
    Ready(PreparedAuthentication),
    Blocking(JoinHandle<AppResult<PreparedAuthentication>>),
}

impl AuthenticationPreparation {
    pub(super) async fn resolve(self) -> AppResult<PreparedAuthentication> {
        match self {
            Self::Ready(authentication) => Ok(authentication),
            Self::Blocking(task) => task
                .await
                .map_err(|error| AppError::Remote(format!("SSH 私钥准备任务异常结束：{error}")))?,
        }
    }
}

/// 私钥读取、解密和 KDF 都是同步 CPU/文件操作。连接开始前把它放到 blocking
/// 线程，并与 TCP/KEX 并行，避免在握手完成后再阻塞 Tokio worker 和认证路径。
pub(super) fn prepare_authentication(
    session: &SessionConfig,
) -> AppResult<AuthenticationPreparation> {
    match session.auth.method {
        AuthMethod::Password => {
            let password = session
                .auth
                .password
                .clone()
                .ok_or_else(|| AppError::InvalidInput("密码认证缺少密码".to_string()))?;
            Ok(AuthenticationPreparation::Ready(
                PreparedAuthentication::Password(password),
            ))
        }
        AuthMethod::PrivateKey => {
            let imported = session.auth.imported_private_key.clone();
            let path = session.auth.private_key_path.clone();
            let passphrase = session.auth.private_key_passphrase.clone();
            if imported.is_none() && path.is_none() {
                return Err(AppError::InvalidInput("私钥认证缺少私钥路径".to_string()));
            }
            Ok(AuthenticationPreparation::Blocking(
                tokio::task::spawn_blocking(move || {
                    let key = if let Some(imported) = imported.as_deref() {
                        decode_secret_key(imported, passphrase.as_deref()).map_err(remote_error)?
                    } else {
                        let path = path.as_deref().ok_or_else(|| {
                            AppError::InvalidInput("私钥认证缺少私钥路径".to_string())
                        })?;
                        load_secret_key(Path::new(path), passphrase.as_deref())
                            .map_err(remote_error)?
                    };
                    Ok(PreparedAuthentication::PrivateKey(Arc::new(key)))
                }),
            ))
        }
    }
}

pub(super) async fn authenticate(
    handle: &mut RawSshHandle,
    username: &str,
    authentication: &PreparedAuthentication,
) -> AppResult<()> {
    let authenticated = match authentication {
        PreparedAuthentication::Password(password) => handle
            .authenticate_password(username.to_string(), password)
            .await
            .map_err(remote_error)?
            .success(),
        PreparedAuthentication::PrivateKey(key) if !key.algorithm().is_rsa() => handle
            .authenticate_publickey(
                username.to_string(),
                PrivateKeyWithHashAlg::new(key.clone(), None),
            )
            .await
            .map_err(remote_error)?
            .success(),
        PreparedAuthentication::PrivateKey(key) => {
            authenticate_rsa_key(handle, username, key.clone()).await?
        }
    };

    if authenticated {
        Ok(())
    } else {
        Err(AppError::Remote("SSH 认证失败".to_string()))
    }
}

async fn authenticate_rsa_key(
    handle: &mut RawSshHandle,
    username: &str,
    key: Arc<ssh_key::PrivateKey>,
) -> AppResult<bool> {
    let advertised = match timeout(
        RSA_SIGNATURE_PROBE_TIMEOUT,
        handle.best_supported_rsa_hash(),
    )
    .await
    {
        Ok(Ok(Some(hash))) => Some(hash),
        Ok(Ok(None)) => None,
        Ok(Err(error)) => {
            log::debug!("RSA server-sig-algs probe failed; using compatibility fallbacks: {error}");
            None
        }
        Err(_) => {
            log::debug!(
                "RSA server-sig-algs probe exceeded {}ms; using fast compatibility fallbacks",
                RSA_SIGNATURE_PROBE_TIMEOUT.as_millis()
            );
            None
        }
    };

    let mut candidates = advertised.map(|hash| vec![hash]).unwrap_or_else(|| {
        vec![
            Some(ssh_key::HashAlg::Sha512),
            Some(ssh_key::HashAlg::Sha256),
            None,
        ]
    });
    candidates.dedup();
    for (index, hash) in candidates.into_iter().enumerate() {
        let result = handle
            .authenticate_publickey(
                username.to_string(),
                PrivateKeyWithHashAlg::new(key.clone(), hash),
            )
            .await
            .map_err(remote_error)?;
        if result.success() {
            return Ok(true);
        }
        if index == 0 {
            log::debug!(
                "primary RSA signature algorithm was rejected; trying compatibility fallback"
            );
        }
    }
    Ok(false)
}

/// SSH 控制面操作的硬超时。若 SSH session 已经静默死亡，russh 自身要等
/// `keepalive_interval × keepalive_max ≈ 45s` 才会把 handle 标记 closed；在那之前，
/// 打开通道、申请/取消远程监听等请求都可能一直等待服务器确认。
///
/// 超时覆盖服务器确认，避免连接静默死亡时控制操作无限等待。
const SSH_CONTROL_TIMEOUT: Duration = Duration::from_secs(5);

/// SSH channel 关闭的硬超时。若 SSH 已死，`channel.close().await`
/// 可能长时间不返回；调用方等待到此上限后直接释放本地句柄。
const CHANNEL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const CHANNEL_SIGNAL_TIMEOUT: Duration = Duration::from_millis(500);
const CHANNEL_TERMINATION_WAIT: Duration = Duration::from_millis(750);
const EXEC_TRACKING_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const EXEC_CLEANUP_TIMEOUT_MS: u64 = 2_000;
const EXEC_CLEANUP_OUTPUT_BYTES: usize = 4 * 1024;
const EXEC_TRACKER_SUPPORTED: u8 = 1;
const EXEC_TRACKER_UNSUPPORTED: u8 = 2;

impl ExecChannelPool {
    pub(super) fn schedule_refill(self: &Arc<Self>, handle: SshHandle) {
        if self.closed.load(Ordering::Acquire)
            || self
                .refilling
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return;
        }

        let pool = self.clone();
        let task = tokio::spawn(async move {
            let opened = open_session_channel(&handle).await;
            match opened {
                Ok(channel) if pool.closed.load(Ordering::Acquire) => {
                    let _ = close_ssh_channel(&channel).await;
                }
                Ok(channel) => {
                    let replaced = {
                        let mut idle = pool.idle.lock().await;
                        if idle.is_none() {
                            *idle = Some(WarmExecChannel {
                                channel,
                                opened_at: Instant::now(),
                            });
                            None
                        } else {
                            Some(channel)
                        }
                    };
                    if let Some(channel) = replaced {
                        let _ = close_ssh_channel(&channel).await;
                    }
                }
                Err(error) => {
                    log::debug!("SSH exec channel prewarm failed: {error}");
                }
            }
            pool.refilling.store(false, Ordering::Release);
        });

        let mut task_slot = lock_unpoisoned(&self.refill_task, "SSH exec channel refill task");
        if self.closed.load(Ordering::Acquire) {
            task.abort();
            self.refilling.store(false, Ordering::Release);
            return;
        }
        if let Some(previous) = task_slot.replace(task) {
            if !previous.is_finished() {
                previous.abort();
            }
        }
    }

    pub(super) async fn take(&self) -> Option<Channel<client::Msg>> {
        let warm = self.idle.lock().await.take()?;
        if warm.opened_at.elapsed() <= EXEC_CHANNEL_MAX_IDLE {
            return Some(warm.channel);
        }
        if let Err(error) = close_ssh_channel(&warm.channel).await {
            log::debug!("failed to close expired prewarmed SSH exec channel: {error}");
        }
        None
    }

    pub(super) async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let task = lock_unpoisoned(&self.refill_task, "SSH exec channel refill task").take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
        self.refilling.store(false, Ordering::Release);
        if let Some(warm) = self.idle.lock().await.take() {
            if let Err(error) = close_ssh_channel(&warm.channel).await {
                log::debug!("failed to close prewarmed SSH exec channel: {error}");
            }
        }
    }
}

impl ExecProcessTracker {
    pub(super) async fn supports_process_groups(&self, handle: &SshHandle) -> bool {
        match self.state.load(Ordering::Acquire) {
            EXEC_TRACKER_SUPPORTED => return true,
            EXEC_TRACKER_UNSUPPORTED => return false,
            _ => {}
        }

        let _probe_guard = self.probe_lock.lock().await;
        match self.state.load(Ordering::Acquire) {
            EXEC_TRACKER_SUPPORTED => return true,
            EXEC_TRACKER_UNSUPPORTED => return false,
            _ => {}
        }

        let supported = timeout(EXEC_TRACKING_PROBE_TIMEOUT, async {
            let channel = open_session_channel(handle).await?;
            let result = exec_with_channel_output_limit(
                channel,
                "test -r /proc/self/environ && command -v sh >/dev/null 2>&1 && command -v env >/dev/null 2>&1 && command -v tr >/dev/null 2>&1 && command -v grep >/dev/null 2>&1 && command -v ps >/dev/null 2>&1 && pid=$$ && pgid=$(ps -o pgid= -p \"$pid\" 2>/dev/null | tr -d ' ') && sid=$(ps -o sid= -p \"$pid\" 2>/dev/null | tr -d ' ') && test \"$pid\" = \"$pgid\" && test \"$pid\" = \"$sid\"".to_string(),
                EXEC_CLEANUP_TIMEOUT_MS,
                EXEC_CLEANUP_OUTPUT_BYTES,
            )
            .await?;
            Ok::<bool, AppError>(!result.timed_out && result.exit_status == Some(0))
        })
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(false);

        self.state.store(
            if supported {
                EXEC_TRACKER_SUPPORTED
            } else {
                EXEC_TRACKER_UNSUPPORTED
            },
            Ordering::Release,
        );
        log::info!(
            "SSH tracked exec process groups: {}",
            if supported {
                "supported"
            } else {
                "unavailable"
            }
        );
        supported
    }
}

#[derive(Clone)]
pub(super) struct RemoteProcessCleanup {
    handle: SshHandle,
    token: String,
}

pub(super) struct TrackedExecCommand {
    pub(super) command: String,
    pub(super) cleanup: RemoteProcessCleanup,
}

fn wrap_tracked_exec_command(token: &str, command: &str) -> String {
    format!(
        "exec env HELM_EXEC_TOKEN={} \"${{SHELL:-/bin/sh}}\" -c {}",
        shell_quote(token),
        shell_quote(command)
    )
}

pub(super) fn build_tracked_exec_command(handle: SshHandle, command: String) -> TrackedExecCommand {
    let token = Uuid::new_v4().simple().to_string();
    let wrapped = wrap_tracked_exec_command(&token, &command);
    TrackedExecCommand {
        command: wrapped,
        cleanup: RemoteProcessCleanup { handle, token },
    }
}

struct RemoteCommandGuard {
    channel: Option<Channel<client::Msg>>,
    cleanup: Option<RemoteProcessCleanup>,
    active: bool,
}

impl RemoteCommandGuard {
    fn new(channel: Channel<client::Msg>) -> Self {
        Self::with_cleanup(channel, None)
    }

    fn tracked(channel: Channel<client::Msg>, cleanup: RemoteProcessCleanup) -> Self {
        Self::with_cleanup(channel, Some(cleanup))
    }

    fn with_cleanup(channel: Channel<client::Msg>, cleanup: Option<RemoteProcessCleanup>) -> Self {
        Self {
            channel: Some(channel),
            cleanup,
            active: false,
        }
    }

    fn channel_mut(&mut self) -> &mut Channel<client::Msg> {
        self.channel
            .as_mut()
            .expect("remote command channel is available until completion")
    }

    fn mark_active(&mut self) {
        self.active = true;
    }

    async fn finish(mut self) {
        self.active = false;
        self.cleanup = None;
        if let Some(channel) = self.channel.take() {
            if let Err(error) = close_ssh_channel(&channel).await {
                log::debug!("failed to close SSH command channel: {error}");
            }
        }
    }

    async fn terminate(mut self, context: &str) {
        self.active = false;
        if let Some(channel) = self.channel.take() {
            // 清理任务独立于调用方生命周期。即使 HTTP 请求或 job task 在等待
            // 信号确认时被 abort，远端终止流程仍会继续完成。
            let context = context.to_string();
            let cleanup = self.cleanup.take();
            let task = tokio::spawn(async move {
                terminate_remote_command(channel, cleanup, &context).await;
            });
            if let Err(error) = task.await {
                log::warn!("remote command termination task failed: {error}");
            }
        }
    }
}

impl Drop for RemoteCommandGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let Some(channel) = self.channel.take() else {
            return;
        };
        let cleanup = self.cleanup.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                terminate_remote_command(channel, cleanup, "命令任务被中止").await;
            });
        }
    }
}

async fn terminate_remote_command(
    channel: Channel<client::Msg>,
    cleanup: Option<RemoteProcessCleanup>,
    context: &str,
) {
    if let Some(cleanup) = cleanup {
        tokio::join!(
            terminate_remote_process(channel, context),
            terminate_tracked_process(cleanup, context)
        );
    } else {
        terminate_remote_process(channel, context).await;
    }
}

async fn terminate_tracked_process(cleanup: RemoteProcessCleanup, context: &str) {
    let cleanup_script = r#"token=$1
attempt=0
pgids=""
while [ "$attempt" -lt 20 ] && [ -z "$pgids" ]; do
  attempt=$((attempt + 1))
  for environment in /proc/[0-9]*/environ; do
    [ -r "$environment" ] || continue
    if tr '\000' '\n' < "$environment" 2>/dev/null | grep -Fqx "HELM_EXEC_TOKEN=$token"; then
      pid=${environment#/proc/}
      pid=${pid%/environ}
      pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
      case "$pgid" in
        ''|*[!0-9]*|0|1) continue ;;
      esac
      case " $pgids " in
        *" $pgid "*) ;;
        *) pgids="$pgids $pgid" ;;
      esac
    fi
  done
  [ -n "$pgids" ] || sleep 0.05
done
for pgid in $pgids; do kill -TERM "-$pgid" 2>/dev/null || true; done
sleep 0.05
for pgid in $pgids; do kill -KILL "-$pgid" 2>/dev/null || true; done"#;
    let command = format!(
        "sh -c {} sh {}",
        shell_quote(cleanup_script),
        shell_quote(&cleanup.token)
    );
    let result = async {
        exec_control_command(
            &cleanup.handle,
            command,
            EXEC_CLEANUP_TIMEOUT_MS,
            EXEC_CLEANUP_OUTPUT_BYTES,
        )
        .await
    }
    .await;
    match result {
        Ok(result) if result.exit_status == Some(0) && !result.timed_out => {}
        Ok(result) => log::warn!(
            "remote tracked process cleanup was incomplete during {context}: exit={:?} timed_out={} stderr={}",
            result.exit_status,
            result.timed_out,
            result.stderr.trim()
        ),
        Err(error) => {
            log::warn!("remote tracked process cleanup failed during {context}: {error}")
        }
    }
}

/// 进程清理自身不能再进入带远端清理守卫的执行路径，否则会形成递归清理。
/// 该命令固定、短小且有硬超时；超时仍会直接向它自己的 channel 发送 KILL。
async fn exec_control_command(
    handle: &SshHandle,
    command: String,
    timeout_ms: u64,
    max_output_bytes: usize,
) -> AppResult<ExecResult> {
    let started = Instant::now();
    let mut channel = open_session_channel(handle).await?;
    run_ssh_channel_control("启动远端清理命令", channel.exec(true, command)).await?;
    let mut stdout = BoundedOutput::new(max_output_bytes);
    let mut stderr = BoundedOutput::new(max_output_bytes);
    let mut exit_status = None;
    let timeout_sleep = tokio::time::sleep(Duration::from_millis(timeout_ms.max(1)));
    tokio::pin!(timeout_sleep);
    let timed_out = loop {
        tokio::select! {
            _ = &mut timeout_sleep => break true,
            message = channel.wait() => {
                let Some(message) = message else {
                    break false;
                };
                match message {
                    ChannelMsg::Data { data } => stdout.push(&data),
                    ChannelMsg::ExtendedData { data, .. } => stderr.push(&data),
                    ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                    _ => {}
                }
            }
        }
    };
    if timed_out {
        stderr.push_line("远端清理命令超时");
        exit_status = Some(124);
        terminate_remote_process(channel, "远端清理命令超时").await;
    } else if let Err(error) = close_ssh_channel(&channel).await {
        log::debug!("failed to close remote cleanup channel: {error}");
    }
    Ok(build_exec_result(
        stdout,
        stderr,
        exit_status,
        started.elapsed().as_millis(),
        timed_out,
    ))
}

async fn terminate_remote_process(mut channel: Channel<client::Msg>, context: &str) {
    match timeout(CHANNEL_SIGNAL_TIMEOUT, channel.signal(Sig::KILL)).await {
        Ok(Ok(())) => {
            // `Channel::signal` 只保证请求已进入 russh 的本地发送队列。立即发送
            // CHANNEL_CLOSE 会让部分服务器来不及处理 signal，远端子进程继续运行。
            // 等待退出消息或 EOF，既给信号一个真实网络往返，也尽量提前结束清理。
            let completed = timeout(CHANNEL_TERMINATION_WAIT, async {
                while let Some(message) = channel.wait().await {
                    if matches!(
                        message,
                        ChannelMsg::ExitStatus { .. }
                            | ChannelMsg::ExitSignal { .. }
                            | ChannelMsg::Eof
                    ) {
                        return true;
                    }
                }
                true
            })
            .await
            .unwrap_or(false);
            if !completed {
                log::warn!("remote process did not confirm termination during {context}");
            }
        }
        Ok(Err(error)) => log::warn!("failed to signal remote process during {context}: {error}"),
        Err(_) => log::warn!("signaling remote process timed out during {context}"),
    }
    if let Err(error) = close_ssh_channel(&channel).await {
        log::debug!("failed to close terminated SSH command channel during {context}: {error}");
    }
}

pub(super) async fn run_ssh_channel_control<T, F>(operation: &str, future: F) -> AppResult<T>
where
    F: std::future::Future<Output = Result<T, russh::Error>>,
{
    match timeout(SSH_CONTROL_TIMEOUT, future).await {
        Ok(result) => result.map_err(remote_error),
        Err(_) => Err(AppError::Remote(format!(
            "{operation}超时（连接可能已断开）"
        ))),
    }
}

pub(super) async fn open_session_channel(handle: &SshHandle) -> AppResult<Channel<client::Msg>> {
    match timeout(SSH_CONTROL_TIMEOUT, handle.channel_open_session()).await {
        Ok(Ok(channel)) => Ok(channel),
        Ok(Err(error)) => Err(AppError::Remote(format!(
            "打开 SSH 通道失败：{}（可能是同一 SSH 连接的 channel 已满）",
            error
        ))),
        Err(_) => Err(AppError::Remote(
            "打开 SSH 通道超时（连接可能已断开或 channel 已满）".to_string(),
        )),
    }
}

pub(super) async fn open_direct_tcpip_channel(
    handle: &SshHandle,
    remote_host: &str,
    remote_port: u16,
) -> AppResult<Channel<client::Msg>> {
    let target = format!("{remote_host}:{remote_port}");
    match timeout(
        SSH_CONTROL_TIMEOUT,
        handle.channel_open_direct_tcpip(
            remote_host.to_string(),
            remote_port as u32,
            "127.0.0.1",
            0,
        ),
    )
    .await
    {
        Ok(Ok(channel)) => Ok(channel),
        Ok(Err(error)) => Err(AppError::Remote(format!(
            "打开 SSH 直连通道失败（{target}）：{error}"
        ))),
        Err(_) => Err(AppError::Remote(format!(
            "打开 SSH 直连通道超时（{target}，连接可能已断开）"
        ))),
    }
}

pub(super) async fn request_remote_forward(
    handle: &SshHandle,
    bind_host: &str,
    bind_port: u32,
) -> AppResult<u32> {
    match timeout(
        SSH_CONTROL_TIMEOUT,
        handle.tcpip_forward(bind_host.to_string(), bind_port),
    )
    .await
    {
        Ok(Ok(port)) => Ok(port),
        Ok(Err(error)) => Err(AppError::Remote(format!(
            "申请远程端口转发失败（{bind_host}:{bind_port}）：{error}"
        ))),
        Err(_) => Err(AppError::Remote(format!(
            "申请远程端口转发超时（{bind_host}:{bind_port}，连接可能已断开）"
        ))),
    }
}

pub(super) async fn cancel_remote_forward(
    handle: &SshHandle,
    bind_host: &str,
    bind_port: u32,
) -> AppResult<()> {
    match timeout(
        SSH_CONTROL_TIMEOUT,
        handle.cancel_tcpip_forward(bind_host.to_string(), bind_port),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(AppError::Remote(format!(
            "取消远程端口转发失败（{bind_host}:{bind_port}）：{error}"
        ))),
        Err(_) => Err(AppError::Remote(format!(
            "取消远程端口转发超时（{bind_host}:{bind_port}，连接可能已断开）"
        ))),
    }
}

pub(super) async fn exec_with_handle(
    handle: &SshHandle,
    command: String,
    timeout_ms: u64,
) -> AppResult<ExecResult> {
    let started = Instant::now();
    let channel_started = Instant::now();
    let channel = open_session_channel(handle).await?;
    let channel_open_ms = channel_started.elapsed().as_millis();
    let mut result = exec_with_channel(channel, command, timeout_ms).await?;
    result.channel_open_ms = channel_open_ms;
    result.duration_ms = started.elapsed().as_millis();
    Ok(result)
}

pub(super) async fn exec_with_channel(
    channel: Channel<client::Msg>,
    command: String,
    timeout_ms: u64,
) -> AppResult<ExecResult> {
    exec_with_channel_output_limit(channel, command, timeout_ms, MAX_EXEC_OUTPUT_BYTES).await
}

pub(super) async fn exec_with_channel_output_limit(
    channel: Channel<client::Msg>,
    command: String,
    timeout_ms: u64,
    max_output_bytes: usize,
) -> AppResult<ExecResult> {
    exec_with_channel_output_limit_inner(channel, command, timeout_ms, max_output_bytes, None).await
}

pub(super) async fn exec_tracked_with_channel_output_limit(
    channel: Channel<client::Msg>,
    tracked: TrackedExecCommand,
    timeout_ms: u64,
    max_output_bytes: usize,
) -> AppResult<ExecResult> {
    exec_with_channel_output_limit_inner(
        channel,
        tracked.command,
        timeout_ms,
        max_output_bytes,
        Some(tracked.cleanup),
    )
    .await
}

async fn exec_with_channel_output_limit_inner(
    channel: Channel<client::Msg>,
    command: String,
    timeout_ms: u64,
    max_output_bytes: usize,
    cleanup: Option<RemoteProcessCleanup>,
) -> AppResult<ExecResult> {
    let started = Instant::now();
    let mut command_guard = match cleanup {
        Some(cleanup) => RemoteCommandGuard::tracked(channel, cleanup),
        None => RemoteCommandGuard::new(channel),
    };
    // 在等待服务器确认 exec 前即进入受控状态，覆盖“请求已到远端、确认包尚未
    // 返回”时本地 future 被取消的窄竞态。
    command_guard.mark_active();
    if let Err(error) = run_ssh_channel_control(
        "启动远程命令",
        command_guard.channel_mut().exec(true, command),
    )
    .await
    {
        command_guard.terminate("启动远程命令失败").await;
        return Err(error);
    }

    let mut stdout = BoundedOutput::new(max_output_bytes);
    let mut stderr = BoundedOutput::new(max_output_bytes);
    let mut exit_status = None;
    let timeout_sleep = tokio::time::sleep(Duration::from_millis(timeout_ms.max(1)));
    tokio::pin!(timeout_sleep);
    let timed_out = loop {
        tokio::select! {
            _ = &mut timeout_sleep => break true,
            message = command_guard.channel_mut().wait() => {
                let Some(message) = message else {
                    break false;
                };
                match message {
                    ChannelMsg::Data { data } => stdout.push(&data),
                    ChannelMsg::ExtendedData { data, .. } => stderr.push(&data),
                    ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                    _ => {}
                }
            }
        }
    };
    if timed_out {
        stderr.push_line("命令执行超时");
        exit_status = Some(124);
        command_guard.terminate("命令执行超时").await;
    } else {
        command_guard.finish().await;
    }

    Ok(build_exec_result(
        stdout,
        stderr,
        exit_status,
        started.elapsed().as_millis(),
        timed_out,
    ))
}

pub(super) async fn exec_stream_with_channel(
    channel: Channel<client::Msg>,
    command: String,
    timeout_ms: u64,
    output: mpsc::Sender<ExecStreamChunk>,
    cancel: watch::Receiver<bool>,
    max_output_bytes: usize,
) -> AppResult<ExecResult> {
    exec_stream_with_channel_inner(
        channel,
        command,
        timeout_ms,
        output,
        cancel,
        max_output_bytes,
        None,
    )
    .await
}

pub(super) async fn exec_tracked_stream_with_channel(
    channel: Channel<client::Msg>,
    tracked: TrackedExecCommand,
    timeout_ms: u64,
    output: mpsc::Sender<ExecStreamChunk>,
    cancel: watch::Receiver<bool>,
    max_output_bytes: usize,
) -> AppResult<ExecResult> {
    exec_stream_with_channel_inner(
        channel,
        tracked.command,
        timeout_ms,
        output,
        cancel,
        max_output_bytes,
        Some(tracked.cleanup),
    )
    .await
}

async fn exec_stream_with_channel_inner(
    channel: Channel<client::Msg>,
    command: String,
    timeout_ms: u64,
    output: mpsc::Sender<ExecStreamChunk>,
    cancel: watch::Receiver<bool>,
    max_output_bytes: usize,
    cleanup: Option<RemoteProcessCleanup>,
) -> AppResult<ExecResult> {
    #[derive(Clone, Copy)]
    enum StreamExit {
        Completed,
        TimedOut,
        Canceled,
    }

    let started = Instant::now();
    let mut command_guard = match cleanup {
        Some(cleanup) => RemoteCommandGuard::tracked(channel, cleanup),
        None => RemoteCommandGuard::new(channel),
    };
    command_guard.mark_active();
    if let Err(error) = run_ssh_channel_control(
        "启动远程命令",
        command_guard.channel_mut().exec(true, command),
    )
    .await
    {
        command_guard.terminate("启动流式远程命令失败").await;
        return Err(error);
    }

    let mut stdout = BoundedOutput::new(max_output_bytes);
    let mut stderr = BoundedOutput::new(max_output_bytes);
    let mut stdout_decoder = Utf8StreamDecoder::default();
    let mut stderr_decoder = Utf8StreamDecoder::default();
    let mut pending_output = None;
    let mut exit_status = None;
    let timeout_sleep = tokio::time::sleep(Duration::from_millis(timeout_ms.max(1)));
    let cancel_wait = async move {
        let mut cancel = cancel;
        loop {
            let requested = *cancel.borrow_and_update();
            if requested {
                break;
            }
            if cancel.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    };
    let mut flush_interval = tokio::time::interval(Duration::from_millis(50));
    flush_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    flush_interval.tick().await;
    tokio::pin!(timeout_sleep);
    tokio::pin!(cancel_wait);

    let stream_exit = loop {
        tokio::select! {
            _ = &mut timeout_sleep => break StreamExit::TimedOut,
            _ = &mut cancel_wait => break StreamExit::Canceled,
            _ = flush_interval.tick() => {
                flush_stream_output(&output, &mut pending_output).await;
            }
            message = command_guard.channel_mut().wait() => {
                let Some(message) = message else {
                    break StreamExit::Completed;
                };
                match message {
                    ChannelMsg::Data { data } => {
                        stdout.push(&data);
                        let text = stdout_decoder.push(&data);
                        if !text.is_empty() {
                            queue_stream_output(
                                &output,
                                &mut pending_output,
                                ExecStreamChunk::Stdout(text),
                            )
                            .await;
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        stderr.push(&data);
                        let text = stderr_decoder.push(&data);
                        if !text.is_empty() {
                            queue_stream_output(
                                &output,
                                &mut pending_output,
                                ExecStreamChunk::Stderr(text),
                            )
                            .await;
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                    _ => {}
                }
            }
        }
    };

    match stream_exit {
        StreamExit::Completed => command_guard.finish().await,
        StreamExit::TimedOut => command_guard.terminate("流式命令执行超时").await,
        StreamExit::Canceled => command_guard.terminate("流式命令已取消").await,
    }

    let stdout_tail = stdout_decoder.finish();
    if !stdout_tail.is_empty() {
        queue_stream_output(
            &output,
            &mut pending_output,
            ExecStreamChunk::Stdout(stdout_tail),
        )
        .await;
    }
    let stderr_tail = stderr_decoder.finish();
    if !stderr_tail.is_empty() {
        queue_stream_output(
            &output,
            &mut pending_output,
            ExecStreamChunk::Stderr(stderr_tail),
        )
        .await;
    }

    match stream_exit {
        StreamExit::Completed => {
            flush_stream_output(&output, &mut pending_output).await;
            Ok(build_exec_result(
                stdout,
                stderr,
                exit_status,
                started.elapsed().as_millis(),
                false,
            ))
        }
        StreamExit::TimedOut => {
            let timeout_text = "命令执行超时";
            stderr.push_line(timeout_text);
            queue_stream_output(
                &output,
                &mut pending_output,
                ExecStreamChunk::Stderr(timeout_text.to_string()),
            )
            .await;
            flush_stream_output(&output, &mut pending_output).await;
            Ok(build_exec_result(
                stdout,
                stderr,
                Some(124),
                started.elapsed().as_millis(),
                true,
            ))
        }
        StreamExit::Canceled => Err(AppError::Remote("命令执行已取消".to_string())),
    }
}

const EXEC_STREAM_CHUNK_BYTES: usize = 16 * 1024;

async fn queue_stream_output(
    output: &mpsc::Sender<ExecStreamChunk>,
    pending: &mut Option<ExecStreamChunk>,
    next: ExecStreamChunk,
) {
    let same_stream = matches!(
        (pending.as_ref(), &next),
        (Some(ExecStreamChunk::Stdout(_)), ExecStreamChunk::Stdout(_))
            | (Some(ExecStreamChunk::Stderr(_)), ExecStreamChunk::Stderr(_))
    );
    if !same_stream {
        flush_stream_output(output, pending).await;
    }
    match next {
        ExecStreamChunk::Stdout(text) => match pending {
            Some(ExecStreamChunk::Stdout(current)) => current.push_str(&text),
            None => *pending = Some(ExecStreamChunk::Stdout(text)),
            _ => unreachable!("stream kind was flushed before replacement"),
        },
        ExecStreamChunk::Stderr(text) => match pending {
            Some(ExecStreamChunk::Stderr(current)) => current.push_str(&text),
            None => *pending = Some(ExecStreamChunk::Stderr(text)),
            _ => unreachable!("stream kind was flushed before replacement"),
        },
    }
    let should_flush =
        pending.as_ref().map(stream_chunk_len).unwrap_or_default() >= EXEC_STREAM_CHUNK_BYTES;
    if should_flush {
        flush_stream_output(output, pending).await;
    }
}

async fn flush_stream_output(
    output: &mpsc::Sender<ExecStreamChunk>,
    pending: &mut Option<ExecStreamChunk>,
) {
    if let Some(chunk) = pending.take() {
        let _ = output.send(chunk).await;
    }
}

fn stream_chunk_len(chunk: &ExecStreamChunk) -> usize {
    match chunk {
        ExecStreamChunk::Stdout(text) | ExecStreamChunk::Stderr(text) => text.len(),
    }
}

fn build_exec_result(
    stdout: BoundedOutput,
    stderr: BoundedOutput,
    exit_status: Option<u32>,
    duration_ms: u128,
    timed_out: bool,
) -> ExecResult {
    let (stdout, stdout_bytes, stdout_truncated) = stdout.into_parts();
    let (stderr, stderr_bytes, stderr_truncated) = stderr.into_parts();
    ExecResult {
        stdout,
        stderr,
        stdout_bytes,
        stderr_bytes,
        output_truncated: stdout_truncated || stderr_truncated,
        exit_status,
        duration_ms,
        execution_ms: duration_ms,
        channel_open_ms: 0,
        connection_ms: 0,
        queue_ms: 0,
        timed_out,
    }
}

struct BoundedOutput {
    bytes: VecDeque<u8>,
    max_bytes: usize,
    total_bytes: u64,
    truncated: bool,
}

impl BoundedOutput {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            max_bytes: max_bytes.max(1),
            total_bytes: 0,
            truncated: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(bytes.len() as u64);
        if bytes.len() >= self.max_bytes {
            self.bytes.clear();
            self.bytes
                .extend(bytes[bytes.len() - self.max_bytes..].iter().copied());
            self.truncated |= self.total_bytes > self.max_bytes as u64;
            return;
        }
        self.bytes.extend(bytes.iter().copied());
        let overflow = self.bytes.len().saturating_sub(self.max_bytes);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.truncated = true;
        }
    }

    fn push_line(&mut self, text: &str) {
        if !self.bytes.is_empty() && self.bytes.back() != Some(&b'\n') {
            self.push(b"\n");
        }
        self.push(text.as_bytes());
    }

    fn into_parts(self) -> (String, u64, bool) {
        let bytes = self.bytes.into_iter().collect::<Vec<_>>();
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        let mut truncated = self.truncated;
        if text.len() > self.max_bytes {
            let mut keep_from = text.len() - self.max_bytes;
            while keep_from < text.len() && !text.is_char_boundary(keep_from) {
                keep_from += 1;
            }
            text.drain(..keep_from);
            truncated = true;
        }
        (text, self.total_bytes, truncated)
    }
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    output.push_str(valid);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        if let Ok(valid) = std::str::from_utf8(&self.pending[..valid_up_to]) {
                            output.push_str(valid);
                        }
                        self.pending.drain(..valid_up_to);
                    }
                    let Some(error_len) = error.error_len() else {
                        break;
                    };
                    output.push('\u{fffd}');
                    self.pending.drain(..error_len.min(self.pending.len()));
                }
            }
        }
        output
    }

    fn finish(&mut self) -> String {
        let output = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        output
    }
}

pub(super) async fn close_ssh_channel(channel: &Channel<client::Msg>) -> AppResult<()> {
    match timeout(CHANNEL_CLOSE_TIMEOUT, channel.close()).await {
        Ok(result) => result.map_err(remote_error),
        Err(_) => Err(AppError::Remote("关闭 SSH 通道超时".to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::{wrap_tracked_exec_command, BoundedOutput, Utf8StreamDecoder};

    #[test]
    fn tracked_exec_reuses_the_openssh_process_group_without_setsid() {
        let wrapped = wrap_tracked_exec_command("token-123", "printf '%s' \"$HOME\"");
        assert_eq!(
            wrapped,
            "exec env HELM_EXEC_TOKEN='token-123' \"${SHELL:-/bin/sh}\" -c 'printf '\\''%s'\\'' \"$HOME\"'"
        );
        assert!(!wrapped.contains("setsid"));
    }

    #[test]
    fn bounded_output_retains_tail_and_original_byte_count() {
        let mut output = BoundedOutput::new(5);
        output.push(b"hello");
        output.push(b" world");
        let (text, bytes, truncated) = output.into_parts();
        assert_eq!(text, "world");
        assert_eq!(bytes, 11);
        assert!(truncated);
    }

    #[test]
    fn streaming_utf8_decoder_preserves_characters_split_across_chunks() {
        let mut decoder = Utf8StreamDecoder::default();
        let bytes = "输出完成".as_bytes();
        assert_eq!(decoder.push(&bytes[..2]), "");
        assert_eq!(decoder.push(&bytes[2..7]), "输出");
        assert_eq!(decoder.push(&bytes[7..]), "完成");
        assert_eq!(decoder.finish(), "");
    }
}
