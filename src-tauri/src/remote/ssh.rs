use super::*;

pub(super) async fn authenticate(
    handle: &mut RawSshHandle,
    session: &SessionConfig,
) -> AppResult<()> {
    let authenticated = match session.auth.method {
        AuthMethod::Password => {
            let password = session
                .auth
                .password
                .as_deref()
                .ok_or_else(|| AppError::InvalidInput("密码认证缺少密码".to_string()))?;
            handle
                .authenticate_password(session.username.clone(), password)
                .await
                .map_err(remote_error)?
                .success()
        }
        AuthMethod::PrivateKey => {
            let passphrase = session.auth.private_key_passphrase.as_deref();
            let key = if let Some(imported) = session.auth.imported_private_key.as_deref() {
                decode_secret_key(imported, passphrase).map_err(remote_error)?
            } else {
                let path =
                    session.auth.private_key_path.as_deref().ok_or_else(|| {
                        AppError::InvalidInput("私钥认证缺少私钥路径".to_string())
                    })?;
                load_secret_key(Path::new(path), passphrase).map_err(remote_error)?
            };
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(remote_error)?
                .flatten();
            handle
                .authenticate_publickey(
                    session.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(remote_error)?
                .success()
        }
    };

    if authenticated {
        Ok(())
    } else {
        Err(AppError::Remote("SSH 认证失败".to_string()))
    }
}

/// SSH 控制面操作的硬超时。若 SSH session 已经静默死亡，russh 自身要等
/// `keepalive_interval × keepalive_max ≈ 45s` 才会把 handle 标记 closed；在那之前，
/// 打开通道、申请/取消远程监听等请求都可能一直等待服务器确认。
///
/// 超时范围同时覆盖 handle 锁等待，避免某个慢请求让后续控制操作无限排队。
const SSH_CONTROL_TIMEOUT: Duration = Duration::from_secs(5);

/// SSH channel 关闭的硬超时。若 SSH 已死，`channel.close().await`
/// 可能长时间不返回；调用方等待到此上限后直接释放本地句柄。
const CHANNEL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

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
    match timeout(SSH_CONTROL_TIMEOUT, async {
        let handle = handle.lock().await;
        handle.channel_open_session().await
    })
    .await
    {
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
    match timeout(SSH_CONTROL_TIMEOUT, async {
        let handle = handle.lock().await;
        handle
            .channel_open_direct_tcpip(remote_host.to_string(), remote_port as u32, "127.0.0.1", 0)
            .await
    })
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
    match timeout(SSH_CONTROL_TIMEOUT, async {
        let handle = handle.lock().await;
        handle.tcpip_forward(bind_host.to_string(), bind_port).await
    })
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
    match timeout(SSH_CONTROL_TIMEOUT, async {
        let handle = handle.lock().await;
        handle
            .cancel_tcpip_forward(bind_host.to_string(), bind_port)
            .await
    })
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
    let channel = open_session_channel(handle).await?;
    exec_with_channel(channel, command, timeout_ms).await
}

pub(super) async fn exec_with_channel(
    channel: Channel<client::Msg>,
    command: String,
    timeout_ms: u64,
) -> AppResult<ExecResult> {
    let started = Instant::now();
    let timeout_duration = Duration::from_millis(timeout_ms.max(1));
    let mut channel = channel;
    let result = timeout(timeout_duration, async {
        run_ssh_channel_control("启动远程命令", channel.exec(true, command)).await?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                _ => {}
            }
        }
        Ok::<_, AppError>((stdout, stderr, exit_status))
    })
    .await;
    if let Err(error) = close_ssh_channel(&channel).await {
        log::debug!("failed to close SSH command channel: {error}");
    }

    match result {
        Ok(Ok((stdout, stderr, exit_status))) => Ok(ExecResult {
            stdout: String::from_utf8_lossy(&stdout).to_string(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
            exit_status,
            duration_ms: started.elapsed().as_millis(),
            timed_out: false,
        }),
        Ok(Err(error)) => Err(error),
        Err(_) => Ok(ExecResult {
            stdout: String::new(),
            stderr: "命令执行超时".to_string(),
            exit_status: Some(124),
            duration_ms: started.elapsed().as_millis(),
            timed_out: true,
        }),
    }
}

pub(super) async fn close_ssh_channel(channel: &Channel<client::Msg>) -> AppResult<()> {
    match timeout(CHANNEL_CLOSE_TIMEOUT, channel.close()).await {
        Ok(result) => result.map_err(remote_error),
        Err(_) => Err(AppError::Remote("关闭 SSH 通道超时".to_string())),
    }
}
