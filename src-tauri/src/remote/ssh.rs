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

/// 单次 channel_open_session 的硬超时。若 SSH session 已经静默死亡，russh 自身要等
/// `keepalive_interval × keepalive_max ≈ 45s` 才会把 handle 标记 closed；在那之前
/// `channel_open_session().await` 会一直挂着。这里挂载在 `handle.lock()` 之内，
/// 一旦超时就放锁、释放整条排队，避免一个挂死请求拖垮所有并发。
const CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(5);

/// AutoClosingChannel::drop 里 spawn 的 close 任务的硬超时。若 SSH 已死，
/// `channel.close().await` 永不返回，会泄漏 tokio task。给它套一层 5s 超时止血。
const CHANNEL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) async fn open_session_channel(handle: &SshHandle) -> AppResult<Channel<client::Msg>> {
    let handle = handle.lock().await;
    match timeout(CHANNEL_OPEN_TIMEOUT, handle.channel_open_session()).await {
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
    let future = async {
        let mut channel = AutoClosingChannel::new(channel);
        channel.exec(command).await.map_err(remote_error)?;

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
    };

    match timeout(timeout_duration, future).await {
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

struct AutoClosingChannel(Option<Channel<client::Msg>>);

impl AutoClosingChannel {
    fn new(channel: Channel<client::Msg>) -> Self {
        Self(Some(channel))
    }

    async fn exec(&self, command: String) -> Result<(), russh::Error> {
        self.0
            .as_ref()
            .expect("channel exists until drop")
            .exec(true, command)
            .await
    }

    async fn wait(&mut self) -> Option<ChannelMsg> {
        self.0.as_mut()?.wait().await
    }
}

impl Drop for AutoClosingChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            tokio::spawn(async move {
                // 套一层 5s 超时：SSH 已死时 close().await 永不返回，会让本任务永久挂起，
                // 长跑场景下每次 exec 超时都泄漏一个 tokio task。
                let _ = timeout(CHANNEL_CLOSE_TIMEOUT, channel.close()).await;
            });
        }
    }
}
