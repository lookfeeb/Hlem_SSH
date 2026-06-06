use super::*;
use socket2::{SockRef, TcpKeepalive};
use std::time::Duration;

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
    let _ = sock.set_tcp_keepalive(&ka);
}

pub(super) async fn connect_tcp_for_ssh(
    host: &str,
    port: u16,
    proxy: Option<&SshProxyOptions>,
) -> AppResult<TcpStream> {
    let stream = match proxy {
        None => TcpStream::connect((host, port))
            .await
            .map_err(remote_error)?,
        Some(p) => match p.kind.as_str() {
            "direct" => TcpStream::connect((host, port))
                .await
                .map_err(remote_error)?,
            "socks5" => connect_via_socks5(p, host, port).await?,
            "httpConnect" => connect_via_http_connect(p, host, port).await?,
            _ => return Err(AppError::InvalidInput("代理类型无效".to_string())),
        },
    };
    enable_tcp_keepalive(&stream);
    Ok(stream)
}

pub(super) async fn connect_via_socks5(
    proxy: &SshProxyOptions,
    target_host: &str,
    target_port: u16,
) -> AppResult<TcpStream> {
    if target_host.len() > u8::MAX as usize {
        return Err(AppError::InvalidInput("SOCKS5 目标主机名过长".to_string()));
    }
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(remote_error)?;
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
    Ok(stream)
}

pub(super) async fn connect_via_http_connect(
    proxy: &SshProxyOptions,
    target_host: &str,
    target_port: u16,
) -> AppResult<TcpStream> {
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(remote_error)?;
    let request = format!(
        "CONNECT {target_host}:{target_port} HTTP/1.1\r\nHost: {target_host}:{target_port}\r\nProxy-Connection: keep-alive\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(remote_error)?;
    let response = read_http_header(&mut stream).await?;
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
    let channel = {
        let handle = handle.lock().await;
        handle
            .channel_open_direct_tcpip(remote_host, remote_port as u32, "127.0.0.1", 0)
            .await
            .map_err(remote_error)?
    };
    let mut remote = channel.into_stream();
    io::copy_bidirectional(&mut local, &mut remote)
        .await
        .map_err(remote_error)?;
    Ok(())
}

pub(super) async fn handle_socks5(mut stream: TcpStream, handle: SshHandle) -> AppResult<()> {
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
    stream.write_all(&[5, 0]).await.map_err(remote_error)?;

    let mut header = [0u8; 4];
    stream.read_exact(&mut header).await.map_err(remote_error)?;
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
            let mut name = vec![0u8; len[0] as usize];
            stream.read_exact(&mut name).await.map_err(remote_error)?;
            String::from_utf8_lossy(&name).to_string()
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
    stream
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(remote_error)?;
    pipe_local_to_ssh(stream, handle, host, port).await
}
