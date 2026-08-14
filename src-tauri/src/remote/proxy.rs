use super::*;
use socket2::{SockRef, TcpKeepalive};
use std::{net::IpAddr, time::Duration};

const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROXY_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// 开启 TCP 层 SO_KEEPALIVE。SSH 应用层 keepalive (russh `keepalive_interval`)
/// 防御的是"sshd 假死"，但很多 NAT/防火墙只看 TCP 层活跃度，会把空闲连接的
/// 表项老化掉。TCP keepalive 由内核周期性发送空 ACK 探测包，运营商设备
/// 不容易识别和丢弃，比应用层探测更稳。
///
/// 参数：idle=30s, interval=15s, retries=3 — 在 NAT 表项常见的 60s 老化窗口
/// 之内一定会有探测流量，并且失败 ~75s 内能感知到。
fn enable_tcp_keepalive(stream: &TcpStream) {
    let sock = SockRef::from(stream);
    let ka = TcpKeepalive::new()
        .with_time(Duration::from_secs(30))
        .with_interval(Duration::from_secs(15));
    // retries 选项仅在 Linux/部分 Unix 可设；Windows 由系统注册表控制重试次数，
    // 跳过即可。失败不致命：仅是缺失保活探测，连接仍可用。
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "android",
        target_os = "ios"
    ))]
    let ka = ka.with_retries(3);
    if let Err(error) = sock.set_tcp_keepalive(&ka) {
        log::debug!("failed to enable tcp keepalive: {error}");
    }
}

pub(super) async fn connect_tcp_for_ssh(
    host: &str,
    port: u16,
    proxy: Option<&SshProxyOptions>,
) -> AppResult<TcpStream> {
    let stream = match proxy {
        None => connect_tcp_with_timeout(host, port, "SSH 直连").await?,
        Some(p) => match p.kind.as_str() {
            "direct" => connect_tcp_with_timeout(host, port, "SSH 直连").await?,
            _ => connect_via_configured_proxy(p, host, port).await?,
        },
    };
    enable_tcp_keepalive(&stream);
    Ok(stream)
}

pub(super) async fn connect_tcp_with_timeout(
    host: &str,
    port: u16,
    label: &str,
) -> AppResult<TcpStream> {
    #[cfg(windows)]
    if is_non_loopback_target(host) {
        match crate::direct_broker::connect(host, port, label).await {
            Ok(stream) => return Ok(stream),
            Err(error) => log::warn!(
                "SSH direct broker failed; falling back to process-local socket: target={}:{} error={}",
                host,
                port,
                error
            ),
        }
    }
    match tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect((host, port))).await {
        Ok(Ok(stream)) => {
            if is_non_loopback_target(host)
                && stream
                    .local_addr()
                    .map(|address| address.ip().is_loopback())
                    .unwrap_or(false)
            {
                log::warn!(
                    "SSH OS route is transparently redirected to loopback: target={}:{} local={:?}",
                    host,
                    port,
                    stream.local_addr().ok()
                );
            }
            Ok(stream)
        }
        Ok(Err(error)) => Err(AppError::Remote(format!(
            "{label}失败: {host}:{port}: {error}"
        ))),
        Err(_) => Err(AppError::Remote(format!("{label}超时: {host}:{port}"))),
    }
}

fn is_non_loopback_target(host: &str) -> bool {
    let host = host.trim().trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost") {
        return false;
    }
    host.parse::<IpAddr>()
        .map(|address| !address.is_loopback())
        .unwrap_or(true)
}

async fn connect_via_configured_proxy(
    proxy: &SshProxyOptions,
    target_host: &str,
    target_port: u16,
) -> AppResult<TcpStream> {
    match proxy.kind.as_str() {
        "socks5" => connect_via_socks5(proxy, target_host, target_port).await,
        "httpConnect" => connect_via_http_connect(proxy, target_host, target_port).await,
        _ => Err(AppError::InvalidInput("代理类型无效".to_string())),
    }
}

pub(super) async fn connect_via_socks5(
    proxy: &SshProxyOptions,
    target_host: &str,
    target_port: u16,
) -> AppResult<TcpStream> {
    if target_host.len() > u8::MAX as usize {
        return Err(AppError::InvalidInput("SOCKS5 目标主机名过长".to_string()));
    }
    let mut stream =
        connect_tcp_with_timeout(proxy.host.as_str(), proxy.port, "SOCKS5 代理连接").await?;
    match timeout(PROXY_HANDSHAKE_TIMEOUT, async {
        stream.write_all(&[5, 1, 0]).await.map_err(remote_error)?;
        let mut response = [0u8; 2];
        stream
            .read_exact(&mut response)
            .await
            .map_err(remote_error)?;
        if response != [5, 0] {
            return Err(AppError::Remote("SOCKS5 代理拒绝无认证连接".to_string()));
        }
        let mut request = Vec::with_capacity(7 + target_host.len());
        request.extend_from_slice(&[5, 1, 0, 3, target_host.len() as u8]);
        request.extend_from_slice(target_host.as_bytes());
        request.extend_from_slice(&target_port.to_be_bytes());
        stream.write_all(&request).await.map_err(remote_error)?;

        let mut header = [0u8; 4];
        stream.read_exact(&mut header).await.map_err(remote_error)?;
        if header[0] != 5 || header[1] != 0 {
            return Err(AppError::Remote(format!(
                "SOCKS5 代理连接失败: {}",
                header[1]
            )));
        }
        match header[3] {
            1 => {
                let mut addr = [0u8; 4];
                stream.read_exact(&mut addr).await.map_err(remote_error)?;
            }
            3 => {
                let mut len = [0u8; 1];
                stream.read_exact(&mut len).await.map_err(remote_error)?;
                let mut name = vec![0u8; len[0] as usize];
                stream.read_exact(&mut name).await.map_err(remote_error)?;
            }
            4 => {
                let mut addr = [0u8; 16];
                stream.read_exact(&mut addr).await.map_err(remote_error)?;
            }
            _ => {
                return Err(AppError::Remote(
                    "SOCKS5 代理返回了不支持的地址类型".to_string(),
                ));
            }
        }
        let mut bound_port = [0u8; 2];
        stream
            .read_exact(&mut bound_port)
            .await
            .map_err(remote_error)?;
        Ok::<(), AppError>(())
    })
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            return Err(AppError::Remote(format!(
                "SOCKS5 代理握手超时: {}:{}",
                proxy.host, proxy.port
            )));
        }
    }
    Ok(stream)
}

pub(super) async fn connect_via_http_connect(
    proxy: &SshProxyOptions,
    target_host: &str,
    target_port: u16,
) -> AppResult<TcpStream> {
    let mut stream =
        connect_tcp_with_timeout(proxy.host.as_str(), proxy.port, "HTTP CONNECT 代理连接").await?;
    let request = format!(
        "CONNECT {target_host}:{target_port} HTTP/1.1\r\nHost: {target_host}:{target_port}\r\nProxy-Connection: keep-alive\r\n\r\n"
    );
    let response = match timeout(PROXY_HANDSHAKE_TIMEOUT, async {
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(remote_error)?;
        read_http_header(&mut stream).await
    })
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            return Err(AppError::Remote(format!(
                "HTTP CONNECT 代理握手超时: {}:{}",
                proxy.host, proxy.port
            )));
        }
    };
    let status_line = response.lines().next().unwrap_or_default();
    if !status_line.contains(" 200 ") {
        return Err(AppError::Remote(format!(
            "HTTP CONNECT 代理连接失败: {status_line}"
        )));
    }
    Ok(stream)
}

pub(super) async fn read_http_header(stream: &mut TcpStream) -> AppResult<String> {
    let mut buffer = Vec::new();
    let mut byte = [0u8; 1];
    while buffer.len() < 16 * 1024 {
        stream.read_exact(&mut byte).await.map_err(remote_error)?;
        buffer.push(byte[0]);
        if buffer.ends_with(b"\r\n\r\n") {
            return Ok(String::from_utf8_lossy(&buffer).to_string());
        }
    }
    Err(AppError::Remote("HTTP CONNECT 代理响应头过大".to_string()))
}

pub(super) async fn pipe_local_to_ssh(
    mut local: TcpStream,
    handle: SshHandle,
    remote_host: String,
    remote_port: u16,
) -> AppResult<()> {
    let channel = open_direct_tcpip_channel(&handle, &remote_host, remote_port).await?;
    let mut remote = channel.into_stream();
    io::copy_bidirectional(&mut local, &mut remote)
        .await
        .map_err(remote_error)?;
    Ok(())
}

pub(super) async fn handle_socks5(mut stream: TcpStream, handle: SshHandle) -> AppResult<()> {
    let target = timeout(PROXY_HANDSHAKE_TIMEOUT, async {
        let mut greeting = [0u8; 2];
        stream
            .read_exact(&mut greeting)
            .await
            .map_err(remote_error)?;
        if greeting[0] != 5 {
            return Err(AppError::Remote("仅支持 SOCKS5".to_string()));
        }
        let mut methods = vec![0u8; greeting[1] as usize];
        stream
            .read_exact(&mut methods)
            .await
            .map_err(remote_error)?;
        if !methods.contains(&0) {
            stream.write_all(&[5, 0xff]).await.map_err(remote_error)?;
            return Err(AppError::Remote(
                "SOCKS5 客户端未提供无认证方式".to_string(),
            ));
        }
        stream.write_all(&[5, 0]).await.map_err(remote_error)?;

        let mut header = [0u8; 4];
        stream.read_exact(&mut header).await.map_err(remote_error)?;
        if header[0] != 5 {
            return Err(AppError::Remote("SOCKS5 请求版本无效".to_string()));
        }
        if header[1] != 1 {
            stream
                .write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0])
                .await
                .map_err(remote_error)?;
            return Err(AppError::Remote("SOCKS5 仅支持 CONNECT".to_string()));
        }
        let host = match header[3] {
            1 => {
                let mut addr = [0u8; 4];
                stream.read_exact(&mut addr).await.map_err(remote_error)?;
                std::net::Ipv4Addr::from(addr).to_string()
            }
            3 => {
                let mut len = [0u8; 1];
                stream.read_exact(&mut len).await.map_err(remote_error)?;
                if len[0] == 0 {
                    return Err(AppError::Remote("SOCKS5 目标主机名为空".to_string()));
                }
                let mut name = vec![0u8; len[0] as usize];
                stream.read_exact(&mut name).await.map_err(remote_error)?;
                String::from_utf8(name)
                    .map_err(|_| AppError::Remote("SOCKS5 目标主机名不是 UTF-8".to_string()))?
            }
            4 => {
                let mut addr = [0u8; 16];
                stream.read_exact(&mut addr).await.map_err(remote_error)?;
                std::net::Ipv6Addr::from(addr).to_string()
            }
            _ => {
                stream
                    .write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0])
                    .await
                    .map_err(remote_error)?;
                return Err(AppError::Remote("SOCKS5 地址类型不支持".to_string()));
            }
        };
        let mut port_bytes = [0u8; 2];
        stream
            .read_exact(&mut port_bytes)
            .await
            .map_err(remote_error)?;
        let port = u16::from_be_bytes(port_bytes);
        if port == 0 {
            return Err(AppError::Remote("SOCKS5 目标端口无效".to_string()));
        }
        Ok::<_, AppError>((host, port))
    })
    .await
    .map_err(|_| AppError::Remote("SOCKS5 客户端握手超时".to_string()))??;

    let channel = match open_direct_tcpip_channel(&handle, &target.0, target.1).await {
        Ok(channel) => channel,
        Err(error) => {
            let _ = timeout(
                PROXY_HANDSHAKE_TIMEOUT,
                stream.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]),
            )
            .await;
            return Err(error);
        }
    };
    timeout(
        PROXY_HANDSHAKE_TIMEOUT,
        stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    )
    .await
    .map_err(|_| AppError::Remote("SOCKS5 响应写入超时".to_string()))?
    .map_err(remote_error)?;
    let mut remote = channel.into_stream();
    io::copy_bidirectional(&mut stream, &mut remote)
        .await
        .map_err(remote_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_target_detection_handles_ip_and_host_names() {
        assert!(is_non_loopback_target("192.0.2.10"));
        assert!(is_non_loopback_target("198.51.100.20"));
        assert!(is_non_loopback_target("ssh.example.com"));
        assert!(!is_non_loopback_target("127.0.0.1"));
        assert!(!is_non_loopback_target("[::1]"));
        assert!(!is_non_loopback_target("localhost"));
    }
}
