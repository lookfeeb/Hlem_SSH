use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream as StdTcpStream, ToSocketAddrs},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use crate::errors::{AppError, AppResult};

const BROKER_ARG: &str = "--helm-direct-broker";
const BROKER_MAGIC: &[u8; 4] = b"HDB1";
const BROKER_TOKEN_BYTES: usize = 32;
const BROKER_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const BROKER_CALLBACK_TIMEOUT: Duration = Duration::from_secs(12);
const BROKER_SOCKET_ACK: u8 = 0xA5;

/// 在 Tauri 初始化前识别一次性直连 broker 子进程。
///
/// broker 只接受命令行中携带的随机令牌，并且只回连父进程临时绑定的
/// 127.0.0.1 端口；完成一条 TCP 流后立即退出，不提供常驻代理能力。
pub fn run_from_args_if_requested() -> bool {
    let mut args = std::env::args();
    let _program = args.next();
    if args.next().as_deref() != Some(BROKER_ARG) {
        return false;
    }

    let callback_port = args.next().and_then(|value| value.parse::<u16>().ok());
    let target_port = args.next().and_then(|value| value.parse::<u16>().ok());
    let target_process_id = args.next().and_then(|value| value.parse::<u32>().ok());
    let token = args.next().and_then(|value| hex::decode(value).ok());
    let target_host = args.next().and_then(|value| {
        URL_SAFE_NO_PAD
            .decode(value)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    });

    if let (
        Some(callback_port),
        Some(target_port),
        Some(target_process_id),
        Some(token),
        Some(target_host),
    ) = (
        callback_port,
        target_port,
        target_process_id,
        token,
        target_host,
    ) {
        if token.len() == BROKER_TOKEN_BYTES && !target_host.trim().is_empty() {
            #[cfg(windows)]
            let _ = run_broker(
                callback_port,
                &token,
                &target_host,
                target_port,
                target_process_id,
            );
        }
    }
    true
}

#[cfg(windows)]
pub(crate) async fn connect(
    target_host: &str,
    target_port: u16,
    label: &str,
) -> AppResult<tokio::net::TcpStream> {
    use rand::{rngs::OsRng, RngCore};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| AppError::Remote(format!("{label} broker 监听失败：{error}")))?;
    let callback_port = listener
        .local_addr()
        .map_err(|error| AppError::Remote(format!("{label} broker 地址获取失败：{error}")))?
        .port();
    let mut token = [0u8; BROKER_TOKEN_BYTES];
    OsRng.fill_bytes(&mut token);
    let broker_pid = spawn_broker(callback_port, &token, target_host, target_port)?;
    let deadline = tokio::time::Instant::now() + BROKER_CALLBACK_TIMEOUT;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(AppError::Remote(format!(
                "{label} broker 启动超时（pid={broker_pid}）"
            )));
        }
        let (mut stream, peer) = tokio::time::timeout(remaining, listener.accept())
            .await
            .map_err(|_| AppError::Remote(format!("{label} broker 回连超时（pid={broker_pid}）")))?
            .map_err(|error| AppError::Remote(format!("{label} broker 回连失败：{error}")))?;
        if !peer.ip().is_loopback() {
            continue;
        }

        let mut presented = [0u8; BROKER_MAGIC.len() + BROKER_TOKEN_BYTES];
        let authenticated = tokio::time::timeout(remaining, stream.read_exact(&mut presented))
            .await
            .ok()
            .and_then(Result::ok)
            .is_some()
            && &presented[..BROKER_MAGIC.len()] == BROKER_MAGIC
            && presented[BROKER_MAGIC.len()..] == token;
        if !authenticated {
            continue;
        }

        let mut status = [0u8; 1];
        tokio::time::timeout(remaining, stream.read_exact(&mut status))
            .await
            .map_err(|_| AppError::Remote(format!("{label} broker 建连结果超时")))?
            .map_err(|error| {
                AppError::Remote(format!("{label} broker 建连结果读取失败：{error}"))
            })?;
        if status[0] == 0 {
            let mut protocol_info = vec![0u8; windows_protocol_info_size()];
            tokio::time::timeout(remaining, stream.read_exact(&mut protocol_info))
                .await
                .map_err(|_| AppError::Remote(format!("{label} broker 套接字接收超时")))?
                .map_err(|error| {
                    AppError::Remote(format!("{label} broker 套接字接收失败：{error}"))
                })?;
            let socket = match socket_from_protocol_info(&protocol_info) {
                Ok(socket) => socket,
                Err(error) => {
                    let _ = stream.write_all(&[0]).await;
                    return Err(AppError::Remote(format!(
                        "{label} broker 套接字接管失败：{error}"
                    )));
                }
            };
            stream
                .write_all(&[BROKER_SOCKET_ACK])
                .await
                .map_err(|error| {
                    AppError::Remote(format!("{label} broker 接管确认失败：{error}"))
                })?;
            log::info!(
                "direct broker socket adopted: target={}:{} broker_pid={}",
                target_host,
                target_port,
                broker_pid
            );
            return Ok(socket);
        }

        let mut length = [0u8; 2];
        stream
            .read_exact(&mut length)
            .await
            .map_err(|error| AppError::Remote(format!("{label} broker 错误读取失败：{error}")))?;
        let mut message = vec![0u8; u16::from_be_bytes(length) as usize];
        stream
            .read_exact(&mut message)
            .await
            .map_err(|error| AppError::Remote(format!("{label} broker 错误读取失败：{error}")))?;
        return Err(AppError::Remote(format!(
            "{label}失败：{}",
            String::from_utf8_lossy(&message)
        )));
    }
}

#[cfg(windows)]
fn run_broker(
    callback_port: u16,
    token: &[u8],
    target_host: &str,
    target_port: u16,
    target_process_id: u32,
) -> std::io::Result<()> {
    let callback = SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, callback_port));
    let mut parent = StdTcpStream::connect_timeout(&callback, Duration::from_secs(3))?;
    parent.set_nodelay(true)?;
    parent.set_read_timeout(Some(Duration::from_secs(3)))?;
    parent.write_all(BROKER_MAGIC)?;
    parent.write_all(token)?;

    let target = match connect_target(target_host, target_port) {
        Ok(stream) => stream,
        Err(error) => {
            let message = error.to_string();
            let bytes = message.as_bytes();
            let bytes = &bytes[..bytes.len().min(u16::MAX as usize)];
            parent.write_all(&[1])?;
            parent.write_all(&(bytes.len() as u16).to_be_bytes())?;
            parent.write_all(bytes)?;
            return Ok(());
        }
    };
    target.set_nodelay(true)?;
    let protocol_info = match duplicate_socket_for_process(&target, target_process_id) {
        Ok(protocol_info) => protocol_info,
        Err(error) => {
            send_broker_error(&mut parent, &error)?;
            return Ok(());
        }
    };
    parent.write_all(&[0])?;
    parent.write_all(protocol_info_as_bytes(&protocol_info))?;
    parent.flush()?;
    let mut acknowledgement = [0u8; 1];
    parent.read_exact(&mut acknowledgement)?;
    if acknowledgement[0] != BROKER_SOCKET_ACK {
        return Err(std::io::Error::other("HelM 主进程未确认接管直连套接字"));
    }
    Ok(())
}

#[cfg(windows)]
fn send_broker_error(parent: &mut StdTcpStream, error: &std::io::Error) -> std::io::Result<()> {
    let message = error.to_string();
    let bytes = message.as_bytes();
    let bytes = &bytes[..bytes.len().min(u16::MAX as usize)];
    parent.write_all(&[1])?;
    parent.write_all(&(bytes.len() as u16).to_be_bytes())?;
    parent.write_all(bytes)
}

fn connect_target(target_host: &str, target_port: u16) -> std::io::Result<StdTcpStream> {
    let started = Instant::now();
    let addresses = (target_host, target_port).to_socket_addrs()?;
    let mut last_error = None;
    for address in addresses {
        let remaining = BROKER_CONNECT_TIMEOUT.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        match StdTcpStream::connect_timeout(&address, remaining) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("连接 {target_host}:{target_port} 超时"),
        )
    }))
}

#[cfg(windows)]
fn windows_protocol_info_size() -> usize {
    std::mem::size_of::<windows_sys::Win32::Networking::WinSock::WSAPROTOCOL_INFOW>()
}

#[cfg(windows)]
fn duplicate_socket_for_process(
    stream: &StdTcpStream,
    target_process_id: u32,
) -> std::io::Result<windows_sys::Win32::Networking::WinSock::WSAPROTOCOL_INFOW> {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{
        WSADuplicateSocketW, WSAGetLastError, WSAPROTOCOL_INFOW,
    };

    let mut protocol_info = WSAPROTOCOL_INFOW::default();
    let result = unsafe {
        WSADuplicateSocketW(
            stream.as_raw_socket() as usize,
            target_process_id,
            &mut protocol_info,
        )
    };
    if result != 0 {
        return Err(std::io::Error::from_raw_os_error(unsafe {
            WSAGetLastError()
        }));
    }
    Ok(protocol_info)
}

#[cfg(windows)]
fn protocol_info_as_bytes(
    protocol_info: &windows_sys::Win32::Networking::WinSock::WSAPROTOCOL_INFOW,
) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(
            (protocol_info as *const windows_sys::Win32::Networking::WinSock::WSAPROTOCOL_INFOW)
                .cast::<u8>(),
            windows_protocol_info_size(),
        )
    }
}

#[cfg(windows)]
fn std_socket_from_protocol_info(protocol_info: &[u8]) -> std::io::Result<StdTcpStream> {
    use std::os::windows::io::{FromRawSocket, RawSocket};
    use windows_sys::Win32::Networking::WinSock::{
        WSAGetLastError, WSASocketW, FROM_PROTOCOL_INFO, INVALID_SOCKET, WSAPROTOCOL_INFOW,
        WSA_FLAG_OVERLAPPED,
    };

    if protocol_info.len() != windows_protocol_info_size() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "broker 套接字协议信息长度错误",
        ));
    }
    let mut info = WSAPROTOCOL_INFOW::default();
    unsafe {
        std::ptr::copy_nonoverlapping(
            protocol_info.as_ptr(),
            (&mut info as *mut WSAPROTOCOL_INFOW).cast::<u8>(),
            protocol_info.len(),
        );
    }
    let socket = unsafe {
        WSASocketW(
            FROM_PROTOCOL_INFO,
            FROM_PROTOCOL_INFO,
            FROM_PROTOCOL_INFO,
            &info,
            0,
            WSA_FLAG_OVERLAPPED,
        )
    };
    if socket == INVALID_SOCKET {
        return Err(std::io::Error::from_raw_os_error(unsafe {
            WSAGetLastError()
        }));
    }
    Ok(unsafe { StdTcpStream::from_raw_socket(socket as RawSocket) })
}

#[cfg(windows)]
fn socket_from_protocol_info(protocol_info: &[u8]) -> std::io::Result<tokio::net::TcpStream> {
    let stream = std_socket_from_protocol_info(protocol_info)?;
    stream.set_nodelay(true)?;
    stream.set_nonblocking(true)?;
    tokio::net::TcpStream::from_std(stream)
}

#[cfg(windows)]
fn spawn_broker(
    callback_port: u16,
    token: &[u8; BROKER_TOKEN_BYTES],
    target_host: &str,
    target_port: u16,
) -> AppResult<u32> {
    let executable = broker_executable()?;
    let args = [
        BROKER_ARG.to_string(),
        callback_port.to_string(),
        target_port.to_string(),
        std::process::id().to_string(),
        hex::encode(token),
        URL_SAFE_NO_PAD.encode(target_host.as_bytes()),
    ];
    match spawn_with_shell_parent(&executable, &args) {
        Ok(pid) => Ok(pid),
        Err(shell_error) => {
            log::warn!(
                "failed to start direct broker with shell parent; using normal child: {}",
                shell_error
            );
            spawn_normal_child(&executable, &args)
        }
    }
}

#[cfg(windows)]
fn broker_executable() -> AppResult<std::path::PathBuf> {
    std::env::current_exe()
        .map_err(|error| AppError::Remote(format!("定位 HelM 直连 broker 失败：{error}")))
}

#[cfg(windows)]
fn spawn_normal_child(executable: &std::path::Path, args: &[String]) -> AppResult<u32> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    let child = std::process::Command::new(executable)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| AppError::Remote(format!("启动 HelM 直连 broker 失败：{error}")))?;
    Ok(child.id())
}

#[cfg(windows)]
fn spawn_with_shell_parent(executable: &std::path::Path, args: &[String]) -> AppResult<u32> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, HANDLE},
        System::Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
            OpenProcess, UpdateProcThreadAttribute, CREATE_NO_WINDOW, EXTENDED_STARTUPINFO_PRESENT,
            PROCESS_CREATE_PROCESS, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
            STARTUPINFOEXW,
        },
        UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId},
    };

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let executable_wide = wide(executable.as_os_str());
    let mut command_line = quote_windows_argument(executable.as_os_str());
    for argument in args {
        command_line.push(' ');
        command_line.push_str(&quote_windows_argument(OsStr::new(argument)));
    }
    let mut command_line_wide = wide(OsStr::new(&command_line));

    unsafe {
        let shell_window = GetShellWindow();
        if shell_window.is_null() {
            return Err(AppError::Remote("未找到 Windows Shell 进程".to_string()));
        }
        let mut shell_pid = 0u32;
        GetWindowThreadProcessId(shell_window, &mut shell_pid);
        if shell_pid == 0 {
            return Err(AppError::Remote("无法获取 Windows Shell PID".to_string()));
        }
        let parent = OpenProcess(PROCESS_CREATE_PROCESS, 0, shell_pid);
        if parent.is_null() {
            return Err(AppError::Remote(format!(
                "无法打开 Windows Shell 进程（错误码 {}）",
                GetLastError()
            )));
        }

        let mut attribute_size = 0usize;
        let _ = InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attribute_size);
        if attribute_size == 0 {
            CloseHandle(parent);
            return Err(AppError::Remote(format!(
                "计算 broker 进程属性空间失败（错误码 {}）",
                GetLastError()
            )));
        }
        let mut attribute_storage = vec![0u8; attribute_size];
        let attribute_list = attribute_storage.as_mut_ptr().cast();
        if InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) == 0 {
            let code = GetLastError();
            CloseHandle(parent);
            return Err(AppError::Remote(format!(
                "初始化 broker 进程属性失败（错误码 {code}）"
            )));
        }
        let updated = UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
            (&parent as *const HANDLE).cast(),
            std::mem::size_of::<HANDLE>(),
            ptr::null_mut(),
            ptr::null(),
        );
        if updated == 0 {
            let code = GetLastError();
            DeleteProcThreadAttributeList(attribute_list);
            CloseHandle(parent);
            return Err(AppError::Remote(format!(
                "设置 broker Shell 父进程失败（错误码 {code}）"
            )));
        }

        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = attribute_list;
        let mut process_info = PROCESS_INFORMATION::default();
        let created = CreateProcessW(
            executable_wide.as_ptr(),
            command_line_wide.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
            ptr::null(),
            ptr::null(),
            &startup.StartupInfo,
            &mut process_info,
        );
        let create_error = if created == 0 {
            Some(GetLastError())
        } else {
            None
        };
        DeleteProcThreadAttributeList(attribute_list);
        CloseHandle(parent);
        if let Some(code) = create_error {
            return Err(AppError::Remote(format!(
                "创建 Shell 直连 broker 失败（错误码 {code}）"
            )));
        }
        CloseHandle(process_info.hThread);
        CloseHandle(process_info.hProcess);
        Ok(process_info.dwProcessId)
    }
}

#[cfg(windows)]
fn quote_windows_argument(value: &std::ffi::OsStr) -> String {
    let value = value.to_string_lossy();
    if !value.is_empty()
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return value.into_owned();
    }

    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                quoted.push(character);
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    #[cfg(windows)]
    fn broker_duplicates_socket_and_authenticates_callback() {
        let target = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let target_port = target.local_addr().unwrap().port();
        let callback = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let callback_port = callback.local_addr().unwrap().port();
        let token = [7u8; BROKER_TOKEN_BYTES];

        let target_thread = std::thread::spawn(move || {
            let (mut stream, _) = target.accept().unwrap();
            let mut request = [0u8; 4];
            stream.read_exact(&mut request).unwrap();
            assert_eq!(&request, b"ping");
            stream.write_all(b"pong").unwrap();
        });
        let broker_thread = std::thread::spawn(move || {
            run_broker(
                callback_port,
                &token,
                "127.0.0.1",
                target_port,
                std::process::id(),
            )
            .unwrap();
        });

        let (mut stream, _) = callback.accept().unwrap();
        let mut greeting = [0u8; BROKER_MAGIC.len() + BROKER_TOKEN_BYTES + 1];
        stream.read_exact(&mut greeting).unwrap();
        assert_eq!(&greeting[..BROKER_MAGIC.len()], BROKER_MAGIC);
        assert_eq!(
            greeting[BROKER_MAGIC.len()..BROKER_MAGIC.len() + BROKER_TOKEN_BYTES],
            token
        );
        assert_eq!(greeting[greeting.len() - 1], 0);
        let mut protocol_info = vec![0u8; windows_protocol_info_size()];
        stream.read_exact(&mut protocol_info).unwrap();
        let mut duplicated = std_socket_from_protocol_info(&protocol_info).unwrap();
        stream.write_all(&[BROKER_SOCKET_ACK]).unwrap();
        duplicated.write_all(b"ping").unwrap();
        let mut response = [0u8; 4];
        duplicated.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"pong");
        drop(duplicated);

        target_thread.join().unwrap();
        broker_thread.join().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_argument_quoting_preserves_spaces_and_quotes() {
        assert_eq!(
            quote_windows_argument(std::ffi::OsStr::new(r"C:\Program Files\HelM\helm.exe")),
            r#""C:\Program Files\HelM\helm.exe""#
        );
        assert_eq!(
            quote_windows_argument(std::ffi::OsStr::new(r#"a"b"#)),
            r#""a\"b""#
        );
    }
}
