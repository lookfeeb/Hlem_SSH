use super::*;

pub(super) fn emit_telemetry_snapshot(
    app: &AppHandle,
    info: &TelemetryJobInfo,
    snapshot: ServerTelemetry,
) {
    events::emit(
        app,
        events::TELEMETRY_SNAPSHOT,
        TelemetrySnapshotPayload {
            job_id: info.job_id.clone(),
            session_id: info.session_id.clone(),
            snapshot,
        },
    );
}

pub(super) fn emit_telemetry_error(app: &AppHandle, info: &TelemetryJobInfo, error: String) {
    events::emit(
        app,
        events::TELEMETRY_SNAPSHOT,
        TelemetryErrorPayload {
            job_id: info.job_id.clone(),
            session_id: info.session_id.clone(),
            error,
        },
    );
}

pub(super) fn merge_telemetry(
    target: &mut ServerTelemetry,
    sample: ParsedTelemetry,
    update_latency: bool,
    last_network: &mut Option<(Vec<NetworkBytes>, Instant)>,
) {
    let sampled_at = Instant::now();
    if !sample.network_bytes.is_empty() {
        let current_interfaces = sample.network_bytes.clone();
        target.network.interface_name = current_interfaces[0].interface_name.clone();
        let mut next_interfaces = current_interfaces
            .iter()
            .map(|item| NetworkInterfaceMetric {
                interface_name: item.interface_name.clone(),
                upload_kbps: 0.0,
                download_kbps: 0.0,
                link_speed_mbps: item.link_speed_mbps,
            })
            .collect::<Vec<_>>();
        target.network.upload_kbps = 0.0;
        target.network.download_kbps = 0.0;

        if let Some((previous_interfaces, previous_at)) = last_network.as_ref() {
            let elapsed = sampled_at.duration_since(*previous_at).as_secs_f64();
            if elapsed > 0.0 {
                for metric in &mut next_interfaces {
                    let Some(current) = current_interfaces
                        .iter()
                        .find(|item| item.interface_name == metric.interface_name)
                    else {
                        continue;
                    };
                    let Some(previous) = previous_interfaces
                        .iter()
                        .find(|item| item.interface_name == metric.interface_name)
                    else {
                        continue;
                    };
                    metric.download_kbps = bytes_per_second_to_kib(
                        current.rx_bytes.saturating_sub(previous.rx_bytes),
                        elapsed,
                    );
                    metric.upload_kbps = bytes_per_second_to_kib(
                        current.tx_bytes.saturating_sub(previous.tx_bytes),
                        elapsed,
                    );
                }
                if let Some(primary) = next_interfaces.first() {
                    target.network.download_kbps = primary.download_kbps;
                    target.network.upload_kbps = primary.upload_kbps;
                }
            }
        }
        target.network.interfaces = next_interfaces;
        *last_network = Some((current_interfaces, sampled_at));
    }

    let source = sample.snapshot;
    if has_telemetry_tag(&sample.output, "UPTIME") {
        target.uptime = source.uptime;
    }
    if has_telemetry_tag(&sample.output, "MEM") {
        target.memory = source.memory;
    }
    if has_telemetry_tag(&sample.output, "SWAP") {
        target.swap = source.swap;
    }
    if has_telemetry_tag(&sample.output, "CPU") {
        target.cpu = source.cpu;
    }
    if has_telemetry_tag(&sample.output, "IP") && !source.ip.is_empty() {
        target.ip = source.ip;
    }
    if has_telemetry_tag(&sample.output, "PROC") {
        target.processes = source.processes;
    }
    if has_telemetry_tag(&sample.output, "DISK") {
        target.disks = source.disks;
    }
    if update_latency {
        target.network.latency_ms = source.network.latency_ms;
    }
}

pub(super) fn bytes_per_second_to_kib(bytes: u64, seconds: f64) -> f64 {
    ((bytes as f64 / 1024.0 / seconds) * 10.0).round() / 10.0
}

pub(super) fn has_telemetry_tag(output: &str, tag: &str) -> bool {
    output.lines().any(|line| {
        line.strip_prefix(tag)
            .is_some_and(|rest| rest.starts_with(' '))
    })
}

pub(super) fn parse_linux_telemetry(
    output: &str,
    fallback_ip: &str,
    latency_ms: u128,
) -> ServerTelemetry {
    let mut telemetry = empty_telemetry(fallback_ip, latency_ms);
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        match parts.next() {
            Some("UPTIME") => {
                let seconds = parts
                    .next()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(0);
                telemetry.uptime = format_uptime(seconds);
            }
            Some("MEM") => {
                telemetry.memory = UsageMetric {
                    total: parse_u64(parts.next()),
                    used: parse_u64(parts.next()),
                };
            }
            Some("SWAP") => {
                telemetry.swap = UsageMetric {
                    total: parse_u64(parts.next()),
                    used: parse_u64(parts.next()),
                };
            }
            Some("CPU") => telemetry.cpu = parse_f64(parts.next()).clamp(0.0, 100.0),
            Some("IP") => telemetry.ip = parts.next().unwrap_or(fallback_ip).to_string(),
            Some("NET") => {
                let interface_name = parts.next().unwrap_or("ssh").to_string();
                let _rx_bytes = parts.next();
                let _tx_bytes = parts.next();
                if telemetry.network.interface_name == "ssh" {
                    telemetry.network.interface_name = interface_name.clone();
                }
                telemetry.network.interfaces.push(NetworkInterfaceMetric {
                    interface_name,
                    upload_kbps: 0.0,
                    download_kbps: 0.0,
                    link_speed_mbps: parse_link_speed_mbps(parts.next()),
                });
            }
            Some("DISK") => {
                let mount = parts.next().unwrap_or("").to_string();
                let used = parse_u64(parts.next());
                let total = parse_u64(parts.next());
                if !mount.is_empty() && total > 0 {
                    telemetry.disks.push(DiskMetric { mount, used, total });
                }
            }
            Some("PROC") => {
                let pid = parts
                    .next()
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(0);
                let name = parts.next().unwrap_or("").to_string();
                if pid > 0 && !name.is_empty() {
                    telemetry.processes.push(ProcessInfo {
                        pid,
                        name,
                        cpu: parse_f64(parts.next()),
                        memory: parse_f64(parts.next()),
                    });
                }
            }
            _ => {}
        }
    }
    telemetry.processes.sort_by(|a, b| {
        b.cpu
            .partial_cmp(&a.cpu)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    telemetry.processes.dedup_by_key(|item| item.pid);
    telemetry.processes.truncate(5);
    telemetry.disks.dedup_by(|a, b| a.mount == b.mount);
    telemetry
}

pub(super) fn parse_network_bytes(output: &str) -> Vec<NetworkBytes> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            if parts.next() != Some("NET") {
                return None;
            }
            let interface_name = parts.next()?.to_string();
            let rx_bytes = parts.next()?.parse::<u64>().ok()?;
            let tx_bytes = parts.next()?.parse::<u64>().ok()?;
            let link_speed_mbps = parse_link_speed_mbps(parts.next());
            Some(NetworkBytes {
                interface_name,
                rx_bytes,
                tx_bytes,
                link_speed_mbps,
            })
        })
        .collect()
}

fn parse_link_speed_mbps(value: Option<&str>) -> Option<u64> {
    let speed = value.and_then(|item| item.parse::<u64>().ok())?;
    (speed > 0).then_some(speed)
}

pub(super) fn empty_telemetry(ip: &str, latency_ms: u128) -> ServerTelemetry {
    ServerTelemetry {
        ip: ip.to_string(),
        uptime: "未知".to_string(),
        cpu: 0.0,
        memory: UsageMetric { used: 0, total: 0 },
        swap: UsageMetric { used: 0, total: 0 },
        processes: Vec::new(),
        network: NetworkMetric {
            interface_name: "ssh".to_string(),
            upload_kbps: 0.0,
            download_kbps: 0.0,
            latency_ms,
            interfaces: Vec::new(),
        },
        disks: Vec::new(),
    }
}

pub(super) fn parse_f64(value: Option<&str>) -> f64 {
    value
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0)
}

pub(super) fn parse_u64(value: Option<&str>) -> u64 {
    value
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

pub(super) fn format_uptime(seconds: u64) -> String {
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3_600;
    let minutes = (seconds % 3_600) / 60;
    if days >= 365 {
        let years = days / 365;
        let months = (days % 365) / 30;
        if months > 0 {
            format!("{years} 年 {months} 月")
        } else {
            format!("{years} 年")
        }
    } else if days >= 30 {
        let months = days / 30;
        let remaining_days = days % 30;
        if remaining_days > 0 {
            format!("{months} 月 {remaining_days} 天")
        } else {
            format!("{months} 月")
        }
    } else if days > 0 {
        if hours > 0 {
            format!("{days} 天 {hours} 小时")
        } else {
            format!("{days} 天")
        }
    } else if hours > 0 {
        format!("{hours} 小时 {minutes} 分钟")
    } else {
        format!("{minutes} 分钟")
    }
}

#[cfg(test)]
mod tests {
    use super::format_uptime;

    #[test]
    fn formats_uptime_with_compact_largest_units() {
        assert_eq!(format_uptime(59 * 60), "59 分钟");
        assert_eq!(format_uptime(25 * 3_600), "1 天 1 小时");
        assert_eq!(format_uptime(30 * 86_400), "1 月");
        assert_eq!(format_uptime(400 * 86_400), "1 年 1 月");
    }
}
