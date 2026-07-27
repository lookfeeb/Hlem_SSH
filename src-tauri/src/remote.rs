use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::SeekFrom,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, SystemTime},
};

use chrono::{DateTime, Utc};
use russh::{
    client::{self, Handler},
    keys::{decode_secret_key, load_secret_key, ssh_key, PrivateKeyWithHashAlg},
    Channel, ChannelMsg, ChannelWriteHalf, Disconnect,
};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, FileType as SftpFileType, OpenFlags},
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::{
    fs::{File, OpenOptions},
    io::{self, AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, RwLock, Semaphore},
    task::JoinHandle,
    time::{timeout, Instant, MissedTickBehavior},
};
use uuid::Uuid;

use crate::{
    config::{now, AuthMethod, KnownHostEntry, SessionConfig, SshProxyOptions},
    errors::{AppError, AppResult, HostKeyVerification},
    events,
};

mod event_emitters;
mod lifecycle;
mod proxy;
mod runtime_api;
mod runtime_connection;
mod runtime_forward;
mod runtime_registry;
mod runtime_sftp;
mod runtime_telemetry;
mod runtime_terminal;
mod runtime_transfer;
mod sftp;
mod ssh;
mod telemetry;
mod transfer;
mod transfer_history;

use event_emitters::*;
use lifecycle::*;
use proxy::*;
use sftp::*;
use ssh::*;
use telemetry::*;
use transfer::*;

const DEFAULT_EXEC_TIMEOUT_MS: u64 = 20_000;
const MAX_TEXT_EDIT_BYTES: u64 = 10 * 1024 * 1024;
const TELEMETRY_PROCESS_MIN_INTERVAL_MS: u64 = 15_000;
const TELEMETRY_DISK_MIN_INTERVAL_MS: u64 = 60_000;
const TELEMETRY_IP_MIN_INTERVAL_MS: u64 = 600_000;
const TELEMETRY_FAST_TIMEOUT_MS: u64 = 8_000;
const TELEMETRY_SLOW_TIMEOUT_MS: u64 = 12_000;
const MAX_SFTP_TRANSFER_CONCURRENCY: usize = 4;
const SFTP_TRANSFER_POOL_SIZE: usize = 4;
const MAX_SFTP_SEARCH_CONCURRENCY: usize = 12;
const MAX_SFTP_SEARCH_DIRS: usize = 800;
const MAX_SFTP_SEARCH_ENTRIES: usize = 6000;
const SFTP_REMOTE_SEARCH_TIMEOUT_MS: u64 = 3_500;
const SFTP_FILE_OPERATION_TIMEOUT_MS: u64 = 30 * 60_000;
const MAX_TRANSFER_HISTORY: usize = 100;
pub(crate) const TRANSFER_BUFFER_BYTES: usize = 1024 * 1024;
const TRANSFER_ACCELERATED_BUFFER_BYTES: usize = 4 * 1024 * 1024;
const TRANSFER_PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(250);
const TRANSFER_PROGRESS_MIN_BYTES: u64 = 1024 * 1024;
const TRANSFER_PROGRESS_MAX_SILENCE: Duration = Duration::from_secs(2);
const TRANSFER_SPEED_SMOOTHING_ALPHA: f64 = 0.35;
/// 文件大于此阈值且非续传时，下载切换到多 File handle 并行模式，
/// 用以绕开 russh-sftp 单 File 串行 read 的瓶颈（每个 handle 自带 in-flight READ）。
/// UI 拖拽下载和 AI API 下载共用同一阈值。
pub(crate) const PARALLEL_DOWNLOAD_THRESHOLD: u64 = 32 * 1024 * 1024;
/// 并行下载并发度。保守取 2，尽量兼顾吞吐与常见 VPS 的 MaxSessions 限制。
/// UI 拖拽下载和 AI API 下载共用。
pub(crate) const PARALLEL_DOWNLOAD_PARTS: u64 = 2;
/// 文件大于此阈值且非续传时，上传切换到多 File handle 分片写入。
/// 单 handle 写入本身已有 pipeline；并行上传主要用于高延迟链路继续撑满 SSH/SFTP 窗口。
pub(crate) const PARALLEL_UPLOAD_THRESHOLD: u64 = 32 * 1024 * 1024;
/// 并行上传并发度。先保守取 2，降低远端 SFTP server 对同一文件并发写的兼容风险。
pub(crate) const PARALLEL_UPLOAD_PARTS: u64 = 2;
const TELEMETRY_BASE_COMMAND: &str = r#"sh -lc 'export LC_ALL=C;
if read -r up _ < /proc/uptime 2>/dev/null; then printf "UPTIME %.0f\n" "$up"; fi;
mem_total=0; mem_free=0; buffers=0; cached=0; sreclaimable=0; shmem=0; swap_total=0; swap_free=0;
while read -r key value _; do
  case "$key" in
    MemTotal:) mem_total=$((value * 1024));;
    MemFree:) mem_free=$((value * 1024));;
    Buffers:) buffers=$((value * 1024));;
    Cached:) cached=$((value * 1024));;
    SReclaimable:) sreclaimable=$((value * 1024));;
    Shmem:) shmem=$((value * 1024));;
    SwapTotal:) swap_total=$((value * 1024));;
    SwapFree:) swap_free=$((value * 1024));;
  esac
done < /proc/meminfo 2>/dev/null;
mem_available=$((mem_free + buffers + cached + sreclaimable - shmem));
[ "$mem_available" -lt 0 ] && mem_available=0;
mem_used=$((mem_total - mem_available));
swap_used=$((swap_total - swap_free));
printf "MEM %s %s\n" "$mem_total" "$mem_used";
printf "SWAP %s %s\n" "$swap_total" "$swap_used";
read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat 2>/dev/null;
total1=$((user + nice + system + idle + iowait + irq + softirq + steal)); idle1=$((idle + iowait));
sleep 0.25;
read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat 2>/dev/null;
total2=$((user + nice + system + idle + iowait + irq + softirq + steal)); idle2=$((idle + iowait));
dt=$((total2 - total1)); di=$((idle2 - idle1));
if [ "$dt" -gt 0 ]; then awk -v dt="$dt" -v di="$di" "BEGIN { printf \"CPU %.1f\\n\", (100 * (dt - di)) / dt }"; fi;
default_iface="";
if [ -r /proc/net/route ]; then
  while read -r iface dest _; do
    [ "$dest" = "00000000" ] && { default_iface="$iface"; break; }
  done < /proc/net/route;
fi;
if [ -r /proc/net/dev ]; then
  if [ -n "$default_iface" ]; then
    while IFS=: read -r iface data; do
      set -- $data;
      [ $# -ge 16 ] || continue;
      iface=$(printf "%s" "$iface" | tr -d " ");
      [ "$iface" = "$default_iface" ] || continue;
      rx=$1; tx=$9;
      [ "$rx" -ge 0 ] 2>/dev/null || continue;
      [ "$tx" -ge 0 ] 2>/dev/null || continue;
      speed=0;
      if [ -r "/sys/class/net/$iface/speed" ]; then
        read -r speed < "/sys/class/net/$iface/speed" 2>/dev/null || speed=0;
      fi;
      case "$speed" in *[!0-9]*|"") speed=0;; esac;
      printf "NET %s %s %s %s\n" "$iface" "$rx" "$tx" "$speed";
      break;
    done < /proc/net/dev;
  fi;
  while IFS=: read -r iface data; do
    set -- $data;
    [ $# -ge 16 ] || continue;
    iface=$(printf "%s" "$iface" | tr -d " ");
    [ "$iface" = "lo" ] && continue;
    [ "$iface" = "$default_iface" ] && continue;
    rx=$1; tx=$9;
    [ "$rx" -ge 0 ] 2>/dev/null || continue;
    [ "$tx" -ge 0 ] 2>/dev/null || continue;
    speed=0;
    if [ -r "/sys/class/net/$iface/speed" ]; then
      read -r speed < "/sys/class/net/$iface/speed" 2>/dev/null || speed=0;
    fi;
    case "$speed" in *[!0-9]*|"") speed=0;; esac;
    printf "NET %s %s %s %s\n" "$iface" "$rx" "$tx" "$speed";
  done < /proc/net/dev;
fi;
'"#;
const TELEMETRY_IP_COMMAND: &str = r#"sh -lc 'export LC_ALL=C;
public_ip="";
if command -v curl >/dev/null 2>&1; then
  public_ip=$(curl -4 -fsS --max-time 2 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 2 https://ifconfig.me/ip 2>/dev/null);
fi;
if [ -z "$public_ip" ] && command -v wget >/dev/null 2>&1; then
  public_ip=$(wget -4 -qO- -T 2 https://api.ipify.org 2>/dev/null || wget -4 -qO- -T 2 https://ifconfig.me/ip 2>/dev/null);
fi;
case "$public_ip" in *[!0-9.]*|"") public_ip="";; esac;
if [ -n "$public_ip" ]; then
  printf "IP %s\n" "$public_ip";
else
  set -- $(hostname -I 2>/dev/null); [ -n "$1" ] && printf "IP %s\n" "$1";
fi;
ipv6="";
if command -v ip >/dev/null 2>&1; then
  ipv6=$(ip -6 addr show scope global 2>/dev/null | awk "/inet6 / { sub(/\/.*/, \"\", \$2); print \$2; exit }");
fi;
if [ -z "$ipv6" ]; then
  for candidate in $(hostname -I 2>/dev/null); do
    case "$candidate" in
      *:*)
        case "$candidate" in fe80:*|::1) ;; *) ipv6="$candidate"; break ;; esac
        ;;
    esac
  done;
fi;
if [ -n "$ipv6" ]; then printf "IPV6 %s\n" "$ipv6"; else printf "IPV6 //\n"; fi;
'"#;
const TELEMETRY_DISK_COMMAND: &str = r#"sh -lc 'export LC_ALL=C;
df -B1 -P 2>/dev/null | while read -r fs total used avail pct mount; do
  [ "$fs" = "Filesystem" ] && continue;
  [ "$total" -gt 0 ] 2>/dev/null || continue;
  printf "DISK %s %s %s\n" "$mount" "$used" "$total";
done;
'"#;
const TELEMETRY_PROCESS_COMMAND: &str = r#"sh -lc 'export LC_ALL=C;
ps -eo pid=,comm=,pcpu=,rss= --sort=-pcpu 2>/dev/null | sed -n "1,8p" | while read -r pid name cpu rss; do
  [ "$pid" -gt 0 ] 2>/dev/null || continue;
  mem_mb=$((rss / 1024));
  printf "PROC %s %s %s %s\n" "$pid" "$name" "$cpu" "$mem_mb";
done'"#;

/// Sentinel marker that frames each telemetry sample on the long-lived channel.
/// Format printed by the remote loop is exactly `__HELM_TM_END__:<tag>\n`.
pub(super) const TELEMETRY_FRAME_SENTINEL: &str = "__HELM_TM_END__:";

/// Long-lived shell loop that replaces N per-tick exec channels with ONE channel.
/// Reads a tag from stdin (`base` / `process` / `disk` / `ip` / `quit`), runs the
/// matching collector, then prints `__HELM_TM_END__:<tag>` on its own line as
/// frame boundary. The Rust side splits on that sentinel to dispatch parses.
pub(super) const TELEMETRY_LOOP_COMMAND: &str = r#"sh -lc 'export LC_ALL=C;
helm_tm_base() {
  if read -r up _ < /proc/uptime 2>/dev/null; then printf "UPTIME %.0f\n" "$up"; fi;
  mem_total=0; mem_free=0; buffers=0; cached=0; sreclaimable=0; shmem=0; swap_total=0; swap_free=0;
  while read -r key value _; do
    case "$key" in
      MemTotal:) mem_total=$((value * 1024));;
      MemFree:) mem_free=$((value * 1024));;
      Buffers:) buffers=$((value * 1024));;
      Cached:) cached=$((value * 1024));;
      SReclaimable:) sreclaimable=$((value * 1024));;
      Shmem:) shmem=$((value * 1024));;
      SwapTotal:) swap_total=$((value * 1024));;
      SwapFree:) swap_free=$((value * 1024));;
    esac;
  done < /proc/meminfo 2>/dev/null;
  mem_available=$((mem_free + buffers + cached + sreclaimable - shmem));
  [ "$mem_available" -lt 0 ] && mem_available=0;
  mem_used=$((mem_total - mem_available));
  swap_used=$((swap_total - swap_free));
  printf "MEM %s %s\n" "$mem_total" "$mem_used";
  printf "SWAP %s %s\n" "$swap_total" "$swap_used";
  read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat 2>/dev/null;
  total1=$((user + nice + system + idle + iowait + irq + softirq + steal)); idle1=$((idle + iowait));
  sleep 0.25;
  read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat 2>/dev/null;
  total2=$((user + nice + system + idle + iowait + irq + softirq + steal)); idle2=$((idle + iowait));
  dt=$((total2 - total1)); di=$((idle2 - idle1));
  if [ "$dt" -gt 0 ]; then awk -v dt="$dt" -v di="$di" "BEGIN { printf \"CPU %.1f\\n\", (100 * (dt - di)) / dt }"; fi;
  default_iface="";
  if [ -r /proc/net/route ]; then
    while read -r iface dest _; do
      [ "$dest" = "00000000" ] && { default_iface="$iface"; break; }
    done < /proc/net/route;
  fi;
  if [ -r /proc/net/dev ]; then
    if [ -n "$default_iface" ]; then
      while IFS=: read -r iface data; do
        set -- $data;
        [ $# -ge 16 ] || continue;
        iface=$(printf "%s" "$iface" | tr -d " ");
        [ "$iface" = "$default_iface" ] || continue;
        rx=$1; tx=$9;
        [ "$rx" -ge 0 ] 2>/dev/null || continue;
        [ "$tx" -ge 0 ] 2>/dev/null || continue;
        speed=0;
        if [ -r "/sys/class/net/$iface/speed" ]; then
          read -r speed < "/sys/class/net/$iface/speed" 2>/dev/null || speed=0;
        fi;
        case "$speed" in *[!0-9]*|"") speed=0;; esac;
        printf "NET %s %s %s %s\n" "$iface" "$rx" "$tx" "$speed";
        break;
      done < /proc/net/dev;
    fi;
    while IFS=: read -r iface data; do
      set -- $data;
      [ $# -ge 16 ] || continue;
      iface=$(printf "%s" "$iface" | tr -d " ");
      [ "$iface" = "lo" ] && continue;
      [ "$iface" = "$default_iface" ] && continue;
      rx=$1; tx=$9;
      [ "$rx" -ge 0 ] 2>/dev/null || continue;
      [ "$tx" -ge 0 ] 2>/dev/null || continue;
      speed=0;
      if [ -r "/sys/class/net/$iface/speed" ]; then
        read -r speed < "/sys/class/net/$iface/speed" 2>/dev/null || speed=0;
      fi;
      case "$speed" in *[!0-9]*|"") speed=0;; esac;
      printf "NET %s %s %s %s\n" "$iface" "$rx" "$tx" "$speed";
    done < /proc/net/dev;
  fi;
};
helm_tm_ip() {
  public_ip="";
  if command -v curl >/dev/null 2>&1; then
    public_ip=$(curl -4 -fsS --max-time 2 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 2 https://ifconfig.me/ip 2>/dev/null);
  fi;
  if [ -z "$public_ip" ] && command -v wget >/dev/null 2>&1; then
    public_ip=$(wget -4 -qO- -T 2 https://api.ipify.org 2>/dev/null || wget -4 -qO- -T 2 https://ifconfig.me/ip 2>/dev/null);
  fi;
  case "$public_ip" in *[!0-9.]*|"") public_ip="";; esac;
  if [ -n "$public_ip" ]; then
    printf "IP %s\n" "$public_ip";
  else
    set -- $(hostname -I 2>/dev/null); [ -n "$1" ] && printf "IP %s\n" "$1";
  fi;
  ipv6="";
  if command -v ip >/dev/null 2>&1; then
    ipv6=$(ip -6 addr show scope global 2>/dev/null | awk "/inet6 / { sub(/\/.*/, \"\", \$2); print \$2; exit }");
  fi;
  if [ -z "$ipv6" ]; then
    for candidate in $(hostname -I 2>/dev/null); do
      case "$candidate" in
        *:*)
          case "$candidate" in fe80:*|::1) ;; *) ipv6="$candidate"; break ;; esac
          ;;
      esac
    done;
  fi;
  if [ -n "$ipv6" ]; then printf "IPV6 %s\n" "$ipv6"; else printf "IPV6 //\n"; fi;
};
helm_tm_disk() {
  df -B1 -P 2>/dev/null | while read -r fs total used avail pct mount; do
    [ "$fs" = "Filesystem" ] && continue;
    [ "$total" -gt 0 ] 2>/dev/null || continue;
    printf "DISK %s %s %s\n" "$mount" "$used" "$total";
  done;
};
helm_tm_proc() {
  ps -eo pid=,comm=,pcpu=,rss= --sort=-pcpu 2>/dev/null | sed -n "1,8p" | while read -r pid name cpu rss; do
    [ "$pid" -gt 0 ] 2>/dev/null || continue;
    mem_mb=$((rss / 1024));
    printf "PROC %s %s %s %s\n" "$pid" "$name" "$cpu" "$mem_mb";
  done;
};
while IFS= read -r helm_tm_tag; do
  case "$helm_tm_tag" in
    base) helm_tm_base ;;
    process) helm_tm_proc ;;
    disk) helm_tm_disk ;;
    ip) helm_tm_ip ;;
    quit) exit 0 ;;
  esac;
  printf "__HELM_TM_END__:%s\n" "$helm_tm_tag";
done'"#;

type RawSshHandle = client::Handle<RemoteClient>;
pub type SshHandle = Arc<Mutex<RawSshHandle>>;
type TerminalWriter = ChannelWriteHalf<client::Msg>;

#[derive(Clone, Default)]
pub struct RemoteRuntime {
    connections: Arc<RwLock<HashMap<String, ConnectionRecord>>>,
    terminals: Arc<RwLock<HashMap<String, TerminalRecord>>>,
    sftp_sessions: Arc<RwLock<HashMap<String, SftpRecord>>>,
    transfers: Arc<RwLock<HashMap<String, TransferRecord>>>,
    transfer_history_path: Arc<RwLock<Option<PathBuf>>>,
    transfer_history_loaded: Arc<AtomicBool>,
    transfer_history_load_lock: Arc<Mutex<()>>,
    telemetry_jobs: Arc<RwLock<HashMap<String, TelemetryJobRecord>>>,
    forwards: Arc<RwLock<HashMap<String, ForwardRecord>>>,
    connection_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    sftp_open_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub connection_id: String,
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub status: RuntimeStatus,
    pub connected_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub terminal_id: String,
    pub connection_id: String,
    pub cols: u16,
    pub rows: u16,
    pub opened_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpInfo {
    pub sftp_id: String,
    pub connection_id: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub key: String,
    pub name: String,
    pub path: String,
    pub file_type: RemoteFileType,
    pub size: u64,
    pub modified_at: String,
    pub permissions: String,
    pub owner: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteFileType {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_status: Option<u32>,
    pub duration_ms: u128,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    pub transfer_id: String,
    #[serde(default)]
    pub session_id: String,
    pub sftp_id: String,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    pub status: TaskStatus,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub speed_kbps: f64,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferHistorySnapshot {
    pub version: u16,
    pub saved_at: String,
    pub transfers: Vec<TransferInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryJobInfo {
    pub job_id: String,
    pub session_id: String,
    pub interval_ms: u64,
    pub status: TaskStatus,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTelemetry {
    pub ip: String,
    pub ipv6: String,
    pub uptime: String,
    pub cpu: f64,
    pub memory: UsageMetric,
    pub swap: UsageMetric,
    pub processes: Vec<ProcessInfo>,
    pub network: NetworkMetric,
    pub disks: Vec<DiskMetric>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageMetric {
    pub used: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu: f64,
    pub memory: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMetric {
    pub interface_name: String,
    pub upload_kbps: f64,
    pub download_kbps: f64,
    pub latency_ms: u128,
    pub interfaces: Vec<NetworkInterfaceMetric>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceMetric {
    pub interface_name: String,
    pub upload_kbps: f64,
    pub download_kbps: f64,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub link_speed_mbps: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskMetric {
    pub mount: String,
    pub used: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub forward_id: String,
    pub session_id: String,
    pub forward_type: ForwardType,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub status: TaskStatus,
    pub started_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeStatus {
    Connecting,
    Connected,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardType {
    Local,
    Remote,
    Dynamic,
}

#[derive(Clone)]
struct ConnectionRecord {
    info: ConnectionInfo,
    handle: SshHandle,
    remote_forwards: Arc<RwLock<HashMap<String, RemoteForwardTarget>>>,
}

#[derive(Clone)]
struct TerminalRecord {
    info: TerminalInfo,
    writer: Arc<Mutex<TerminalWriter>>,
}

#[derive(Clone)]
struct SftpRecord {
    info: SftpInfo,
    session: Arc<SftpSession>,
    transfer_sessions: Arc<RwLock<Vec<Arc<SftpSession>>>>,
    transfer_cursor: Arc<Mutex<usize>>,
    transfer_slots: Arc<Semaphore>,
}

impl SftpRecord {
    async fn next_transfer_session(&self) -> Arc<SftpSession> {
        let sessions = self.transfer_sessions.read().await;
        if sessions.is_empty() {
            return self.session.clone();
        }
        let mut cursor = self.transfer_cursor.lock().await;
        let index = *cursor % sessions.len();
        *cursor = cursor.wrapping_add(1);
        sessions[index].clone()
    }
}

struct TransferRecord {
    info: TransferInfo,
    request: TransferRequest,
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

struct TelemetryJobRecord {
    info: TelemetryJobInfo,
    handle: JoinHandle<()>,
}

struct ParsedTelemetry {
    output: String,
    snapshot: ServerTelemetry,
    network_bytes: Vec<NetworkBytes>,
}

#[derive(Clone)]
struct NetworkBytes {
    interface_name: String,
    rx_bytes: u64,
    tx_bytes: u64,
    link_speed_mbps: Option<u64>,
}

struct ForwardRecord {
    info: ForwardInfo,
    handle: Option<JoinHandle<()>>,
}

pub struct TransferUploadOptions {
    pub sftp_id: String,
    pub local_path: String,
    pub remote_path: String,
    pub overwrite: bool,
    pub accelerated: bool,
    pub resume: bool,
}

pub struct ForwardLocalOptions {
    pub session_id: String,
    pub connection_id: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

pub struct ForwardRemoteOptions {
    pub session_id: String,
    pub connection_id: String,
    pub remote_bind_host: String,
    pub remote_bind_port: u16,
    pub local_host: String,
    pub local_port: u16,
}

#[derive(Clone)]
struct TransferRequest {
    sftp_id: String,
    direction: TransferDirection,
    local_path: String,
    remote_path: String,
    overwrite: bool,
    accelerated: bool,
    resume: bool,
}

#[derive(Debug, Clone)]
struct RemoteForwardTarget {
    local_host: String,
    local_port: u16,
}

#[derive(Clone)]
pub struct RemoteClient {
    verification: HostKeyVerification,
    trusted: Option<KnownHostEntry>,
    observed: Arc<StdMutex<Option<HostKeyVerification>>>,
    remote_forwards: Arc<RwLock<HashMap<String, RemoteForwardTarget>>>,
}

impl Handler for RemoteClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = format!(
            "{}",
            server_public_key.fingerprint(ssh_key::HashAlg::Sha256)
        );
        let algorithm = server_public_key.algorithm().to_string();
        let mut observed = self.verification.clone();
        observed.algorithm = algorithm;
        observed.fingerprint = fingerprint.clone();
        observed.expected_fingerprint =
            self.trusted.as_ref().map(|entry| entry.fingerprint.clone());
        if let Ok(mut guard) = self.observed.lock() {
            *guard = Some(observed);
        }

        Ok(self
            .trusted
            .as_ref()
            .is_some_and(|entry| entry.fingerprint == fingerprint))
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let key = forward_key(connected_address, connected_port as u16);
        let target = self.remote_forwards.read().await.get(&key).cloned();
        match target {
            Some(target) => {
                tokio::spawn(async move {
                    if let Ok(mut local) = connect_tcp_with_timeout(
                        target.local_host.as_str(),
                        target.local_port,
                        "远程转发回连本地服务",
                    )
                    .await
                    {
                        let mut remote = channel.into_stream();
                        if let Err(error) = io::copy_bidirectional(&mut local, &mut remote).await {
                            eprintln!(
                                "[helm] remote forward stream failed: {}:{}: {error}",
                                target.local_host, target.local_port
                            );
                        }
                    } else if let Err(error) = channel.close().await {
                        eprintln!("[helm] failed to close remote forward channel: {error}");
                    }
                });
            }
            None => {
                if let Err(error) = channel.close().await {
                    eprintln!("[helm] failed to close unknown remote forward channel: {error}");
                }
            }
        }
        Ok(())
    }
}

fn forward_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linux_telemetry_output() {
        let output = "\
UPTIME 90061
MEM 4096 1024
SWAP 2048 128
CPU 12.5
IP 10.0.0.5
IPV6 2604:a880:400:d0::1
NET eth0 1048576 2097152 0
DISK / 100 200
PROC 42 sshd 1.5 20.0
";
        let telemetry = parse_linux_telemetry(output, "127.0.0.1", 33);
        assert_eq!(telemetry.ip, "10.0.0.5");
        assert_eq!(telemetry.ipv6, "2604:a880:400:d0::1");
        assert_eq!(telemetry.uptime, "1 天 1 小时");
        assert_eq!(telemetry.memory.used, 1024);
        assert_eq!(telemetry.memory.total, 4096);
        assert_eq!(telemetry.cpu, 12.5);
        assert_eq!(telemetry.disks[0].mount, "/");
        assert_eq!(telemetry.processes[0].pid, 42);
        assert_eq!(telemetry.network.latency_ms, 33);
        assert_eq!(telemetry.network.interfaces[0].interface_name, "eth0");
        assert_eq!(telemetry.network.interfaces[0].rx_bytes, 1_048_576);
        assert_eq!(telemetry.network.interfaces[0].tx_bytes, 2_097_152);
        assert_eq!(telemetry.network.interfaces[0].link_speed_mbps, None);
    }

    #[test]
    fn ignores_invalid_telemetry_rows() {
        let output = "\
DISK / 0 0
PROC 0 process 0 0
PROC 42 sshd 1.5 20.0
";
        let telemetry = parse_linux_telemetry(output, "127.0.0.1", 0);
        assert!(telemetry.disks.is_empty());
        assert_eq!(telemetry.processes.len(), 1);
        assert_eq!(telemetry.processes[0].pid, 42);
    }

    #[test]
    fn telemetry_base_command_keeps_outer_shell_quote_intact() {
        assert_eq!(TELEMETRY_BASE_COMMAND.matches('\'').count(), 2);
        assert!(TELEMETRY_BASE_COMMAND.contains("awk -v dt="));
    }

    #[test]
    fn normalizes_and_joins_remote_paths() {
        assert_eq!(normalize_remote_path("tmp//app/"), "/tmp/app");
        assert_eq!(join_remote_path("/", "var"), "/var");
        assert_eq!(join_remote_path("/tmp", "app.log"), "/tmp/app.log");
    }

    #[test]
    fn shell_quotes_find_arguments() {
        assert_eq!(shell_quote("/tmp/it's here"), "'/tmp/it'\\''s here'");
        assert_eq!(
            build_remote_find_command("/tmp/app", "log'2026"),
            "command -v find >/dev/null 2>&1 && find '/tmp/app' -iname '*log'\\''2026*' -print -quit 2>/dev/null"
        );
    }

    #[test]
    fn builds_safe_remote_file_operation_commands() {
        assert_eq!(
            build_remote_mkdir_command("/tmp/it's here"),
            "sh -lc 'mkdir -p -- \"$1\"' sh '/tmp/it'\\''s here'"
        );
        let copy = build_remote_copy_command("/tmp/src dir", "/tmp/-target");
        assert!(copy.contains("cp -a --"));
        assert!(copy.contains("'/tmp/src dir'"));
        assert!(copy.contains("'/tmp/-target'"));
        let replace = build_remote_replace_command("/tmp/a.part", "/tmp/a file");
        assert!(replace.contains("chmod --reference"));
        assert!(replace.contains("mv -f --"));
        assert!(replace.contains("'/tmp/a.part'"));
        assert!(replace.contains("'/tmp/a file'"));
    }

    #[test]
    fn reports_remote_file_command_failure_detail() {
        let error = ensure_remote_file_command_success(
            ExecResult {
                stdout: String::new(),
                stderr: "permission denied\nmore detail".to_string(),
                exit_status: Some(1),
                duration_ms: 12,
                timed_out: false,
            },
            "删除",
        )
        .unwrap_err();
        assert!(error.to_string().contains("删除失败：permission denied"));
    }

    #[test]
    fn protects_root_and_child_directory_targets() {
        assert!(ensure_not_root_path("/", "不能删除根目录").is_err());
        assert!(ensure_not_root_path("/tmp", "不能删除根目录").is_ok());
        assert!(is_same_or_child_remote_path("/tmp/app", "/tmp/app"));
        assert!(is_same_or_child_remote_path("/tmp/app", "/tmp/app/logs"));
        assert!(!is_same_or_child_remote_path("/tmp/app", "/tmp/app2/logs"));
        assert!(ensure_not_same_or_child_path("/tmp/app", "/tmp/app/logs", "bad").is_err());
        assert!(ensure_not_same_or_child_path("/tmp/app", "/tmp/backup/app", "bad").is_ok());
    }

    #[tokio::test]
    async fn new_runtime_has_no_stale_handles() {
        let runtime = RemoteRuntime::default();
        assert!(runtime.ensure_no_stale_handles().await);
    }

    #[tokio::test]
    #[ignore = "requires the local Paramiko SFTP fixture; run explicitly with HELM_TEST_SFTP_PORT and HELM_TEST_SFTP_FINGERPRINT"]
    async fn concurrent_sftp_open_reuses_one_session_per_connection() {
        let port: u16 = std::env::var("HELM_TEST_SFTP_PORT")
            .expect("HELM_TEST_SFTP_PORT is required")
            .parse()
            .expect("HELM_TEST_SFTP_PORT must be a valid u16");
        let fingerprint = std::env::var("HELM_TEST_SFTP_FINGERPRINT")
            .expect("HELM_TEST_SFTP_FINGERPRINT is required");
        let connection_id = "local-sftp-reuse-test".to_string();
        let session_id = "local-sftp-reuse-session".to_string();
        let verification = HostKeyVerification {
            session_id: session_id.clone(),
            host: "127.0.0.1".to_string(),
            port,
            algorithm: String::new(),
            fingerprint: String::new(),
            expected_fingerprint: Some(fingerprint.clone()),
        };
        let client = RemoteClient {
            verification,
            trusted: Some(KnownHostEntry {
                host: "127.0.0.1".to_string(),
                port,
                algorithm: String::new(),
                fingerprint,
                trusted_at: now(),
            }),
            observed: Arc::new(StdMutex::new(None)),
            remote_forwards: Arc::new(RwLock::new(HashMap::new())),
        };
        let socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut handle = client::connect_stream(
            Arc::new(client::Config {
                inactivity_timeout: None,
                nodelay: true,
                ..Default::default()
            }),
            socket,
            client,
        )
        .await
        .unwrap();
        assert!(handle
            .authenticate_password("helm-test", "helm-test")
            .await
            .unwrap()
            .success());

        let runtime = RemoteRuntime::default();
        runtime.connections.write().await.insert(
            connection_id.clone(),
            ConnectionRecord {
                info: ConnectionInfo {
                    connection_id: connection_id.clone(),
                    session_id,
                    host: "127.0.0.1".to_string(),
                    port,
                    username: "helm-test".to_string(),
                    status: RuntimeStatus::Connected,
                    connected_at: now(),
                },
                handle: Arc::new(Mutex::new(handle)),
                remote_forwards: Arc::new(RwLock::new(HashMap::new())),
            },
        );

        let opened =
            futures_util::future::join_all((0..8).map(|_| runtime.open_sftp(&connection_id))).await;
        let infos: Vec<SftpInfo> = opened.into_iter().map(Result::unwrap).collect();
        assert!(infos.iter().all(|info| info.sftp_id == infos[0].sftp_id));
        assert_eq!(runtime.sftp_sessions.read().await.len(), 1);

        let list_started_at = Instant::now();
        let files = runtime
            .sftp_list(&infos[0].sftp_id, "/".to_string())
            .await
            .unwrap();
        assert!(
            list_started_at.elapsed() < Duration::from_secs(1),
            "initial SFTP list should not wait for a secondary SSH exec channel"
        );
        assert!(files.iter().any(|entry| entry.name == "fixture.txt"));

        runtime.close_sftp(&infos[0].sftp_id).await.unwrap();
        let connection = runtime
            .connections
            .write()
            .await
            .remove(&connection_id)
            .unwrap();
        let _ = connection
            .handle
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, "test complete", "en")
            .await;
    }

    #[tokio::test]
    async fn connects_through_socks5_proxy_without_auth() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut greeting = [0u8; 3];
            socket.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [5, 1, 0]);
            socket.write_all(&[5, 0]).await.unwrap();

            let mut head = [0u8; 5];
            socket.read_exact(&mut head).await.unwrap();
            assert_eq!(&head[..4], &[5, 1, 0, 3]);
            let mut host = vec![0u8; head[4] as usize];
            socket.read_exact(&mut host).await.unwrap();
            let mut port = [0u8; 2];
            socket.read_exact(&mut port).await.unwrap();
            assert_eq!(String::from_utf8(host).unwrap(), "example.com");
            assert_eq!(u16::from_be_bytes(port), 22);

            socket
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0x30, 0x39])
                .await
                .unwrap();
        });

        let proxy = SshProxyOptions {
            kind: "socks5".to_string(),
            host: "127.0.0.1".to_string(),
            port: proxy_port,
        };
        let stream = connect_via_socks5(&proxy, "example.com", 22).await;
        assert!(stream.is_ok());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn reports_socks5_connect_failure() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut greeting = [0u8; 3];
            socket.read_exact(&mut greeting).await.unwrap();
            socket.write_all(&[5, 0]).await.unwrap();
            let mut request = [0u8; 18];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(&[5, 5, 0, 1, 127, 0, 0, 1, 0, 0])
                .await
                .unwrap();
        });

        let proxy = SshProxyOptions {
            kind: "socks5".to_string(),
            host: "127.0.0.1".to_string(),
            port: proxy_port,
        };
        assert!(connect_via_socks5(&proxy, "example.com", 22).await.is_err());
    }

    #[tokio::test]
    async fn connects_through_http_connect_proxy() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_header(&mut socket).await.unwrap();
            assert!(request.starts_with("CONNECT example.com:22 HTTP/1.1"));
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
        });

        let proxy = SshProxyOptions {
            kind: "httpConnect".to_string(),
            host: "127.0.0.1".to_string(),
            port: proxy_port,
        };
        let stream = connect_via_http_connect(&proxy, "example.com", 22).await;
        assert!(stream.is_ok());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn reports_http_connect_failure() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_header(&mut socket).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                .await
                .unwrap();
        });

        let proxy = SshProxyOptions {
            kind: "httpConnect".to_string(),
            host: "127.0.0.1".to_string(),
            port: proxy_port,
        };
        assert!(connect_via_http_connect(&proxy, "example.com", 22)
            .await
            .is_err());
    }
}
