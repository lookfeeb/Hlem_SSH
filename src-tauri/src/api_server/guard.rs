/// Check if a command matches known dangerous patterns. The check operates on
/// the lower-cased full command string and looks for patterns that survive
/// common evasion attempts:
///   - shell wrappers: `bash -c "rm -rf /"` / `sh -lc "..."` / etc.
///   - command substitution: `$(rm -rf /)` / backticks
///   - command chaining: `foo; rm -rf /` / `foo && rm -rf /`
///   - find with -delete or -exec rm
///   - dd / mkfs / wipefs / shred targeting block devices
///   - chmod/chown -R on system directories
///   - curl|sh / wget|sh remote-script execution
///   - shutdown / reboot / halt / poweroff / init
///   - redirection that overwrites critical system files
///
/// Returns `Some(reason)` if blocked, `None` if safe.
pub(super) fn check_dangerous_command(command: &str) -> Option<&'static str> {
    let normalized = command.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    let squeezed = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    let parts: Vec<&str> = normalized.split_whitespace().collect();

    // 1. Fork bomb
    if squeezed.contains(":(){ :|:& };:")
        || squeezed.contains(":(){:|:&};:")
        || normalized.contains(":(){")
    {
        return Some("禁止 Fork 炸弹");
    }

    // 2. Recursive rm on root / system / home
    let rm_rf_aliases = ["rm -rf", "rm -fr", "rm -r -f", "rm -f -r"];
    let has_rm_rf = rm_rf_aliases.iter().any(|p| squeezed.contains(p));
    if has_rm_rf {
        if normalized.contains("--no-preserve-root") {
            return Some("禁止跳过根目录保护删除");
        }
        // 精确匹配的危险目标：只拦截这些目录本身或其通配符展开。
        // 例如 `rm -rf /usr` 被拦，但 `rm -rf /tmp/mydir` 放行（非系统目录 + 精确路径）。
        let dangerous_exact = [
            "/", "/*", "/.", "/..", "~", "~/", "$home", "${home}", "/home", "/home/*", "/root",
            "/root/*", "/usr", "/usr/*", "/etc", "/etc/*", "/var", "/var/*", "/boot", "/boot/*",
            "/sys", "/sys/*", "/proc", "/proc/*", "/lib", "/lib/*", "/lib64", "/lib64/*", "/opt",
            "/opt/*", "/sbin", "/sbin/*", "/bin", "/bin/*",
        ];
        // 提取 rm -rf 后面的目标参数（可能有多个），逐个检查是否命中危险目录。
        for alias in rm_rf_aliases {
            if let Some(after) = squeezed.split_once(alias).map(|(_, r)| r) {
                // after 形如 " /tmp/foo" 或 " /usr /etc" 等
                for arg in after.split_whitespace() {
                    // 跳过 flag（如 --verbose）
                    if arg.starts_with('-') {
                        continue;
                    }
                    let normalized_arg = arg.trim_end_matches('/');
                    let check = if normalized_arg.is_empty() {
                        "/"
                    } else {
                        normalized_arg
                    };
                    if dangerous_exact.iter().any(|d| {
                        let d_trimmed = d.trim_end_matches('/');
                        let d_check = if d_trimmed.is_empty() { "/" } else { d_trimmed };
                        check == d_check
                    }) {
                        return Some("禁止递归删除根/系统目录或用户家目录");
                    }
                }
            }
        }
    }

    // 3. find -delete / find -exec rm
    let mentions_find = parts.contains(&"find") || squeezed.contains(" find ");
    if mentions_find {
        if squeezed.contains(" -delete") || squeezed.ends_with(" -delete") {
            return Some("禁止 find -delete");
        }
        if squeezed.contains("-exec rm") || squeezed.contains("-execdir rm") {
            return Some("禁止 find -exec rm");
        }
    }

    // 4. Disk format / wipe / shred on block devices
    if (squeezed.contains("mkfs.") || squeezed.starts_with("mkfs ") || squeezed.contains(" mkfs "))
        && (normalized.contains("/dev/sd")
            || normalized.contains("/dev/nvme")
            || normalized.contains("/dev/vd")
            || normalized.contains("/dev/hd")
            || normalized.contains("/dev/mmc"))
    {
        return Some("禁止格式化磁盘");
    }
    if squeezed.contains("wipefs ") || squeezed.starts_with("wipefs") {
        return Some("禁止 wipefs");
    }
    if squeezed.contains("shred ")
        && (normalized.contains("/dev/sd")
            || normalized.contains("/dev/nvme")
            || normalized.contains("/dev/vd")
            || normalized.contains("/dev/hd"))
    {
        return Some("禁止 shred 块设备");
    }

    // 5. dd writing to a block device
    let mentions_dd = parts.first().copied() == Some("dd")
        || squeezed.contains(" dd ")
        || squeezed.contains(";dd ")
        || squeezed.contains("&& dd ");
    if mentions_dd
        && (normalized.contains("of=/dev/sd")
            || normalized.contains("of=/dev/nvme")
            || normalized.contains("of=/dev/vd")
            || normalized.contains("of=/dev/hd"))
    {
        return Some("禁止 dd 写入块设备");
    }

    // 6. Redirect to a block device
    if normalized.contains("> /dev/sd")
        || normalized.contains(">/dev/sd")
        || normalized.contains("> /dev/nvme")
        || normalized.contains(">/dev/nvme")
        || normalized.contains("> /dev/vd")
        || normalized.contains(">/dev/vd")
        || normalized.contains("> /dev/hd")
        || normalized.contains(">/dev/hd")
    {
        return Some("禁止写入块设备");
    }

    // 7. chmod / chown -R targeting system directories
    let touches_perm = squeezed.contains("chmod ") || squeezed.contains("chown ");
    let recursive_flag = squeezed.contains(" -r ")
        || squeezed.contains(" -rf ")
        || squeezed.contains(" -fr ")
        || squeezed.contains(" -r\t")
        || squeezed.ends_with(" -r");
    if touches_perm && recursive_flag {
        let system_dirs = [
            " /", " /*", " /etc", " /usr", " /var", " /bin", " /sbin", " /lib", " /lib64",
            " /boot", " /home", " /root", " ~",
        ];
        if system_dirs.iter().any(|d| {
            squeezed.contains(&format!("{d} "))
                || squeezed.ends_with(d)
                || squeezed.contains(&format!("{d};"))
        }) {
            return Some("禁止递归修改系统目录权限");
        }
        if squeezed.ends_with(" /") {
            return Some("禁止递归修改系统目录权限");
        }
    }

    // 8. curl/wget piped to shell
    let uses_downloader = squeezed.contains("curl ")
        || squeezed.contains("curl\t")
        || squeezed.contains("wget ")
        || squeezed.contains("wget\t");
    let pipes_to_shell = squeezed.contains("| sh")
        || squeezed.contains("|sh")
        || squeezed.contains("| bash")
        || squeezed.contains("|bash")
        || squeezed.contains("| zsh")
        || squeezed.contains("|zsh")
        || squeezed.contains("| /bin/sh")
        || squeezed.contains("|/bin/sh")
        || squeezed.contains("| /bin/bash")
        || squeezed.contains("|/bin/bash");
    if uses_downloader && pipes_to_shell {
        return Some("禁止远程下载并直接执行脚本");
    }

    // 9. Power-state change commands
    let powerstate_tokens = ["shutdown", "reboot", "halt", "poweroff"];
    if powerstate_tokens.contains(&parts.first().copied().unwrap_or("")) {
        return Some("禁止关机/重启命令");
    }
    for tok in powerstate_tokens {
        if squeezed.contains(&format!(" {tok} "))
            || squeezed.contains(&format!(";{tok} "))
            || squeezed.contains(&format!("&& {tok} "))
            || squeezed.contains(&format!(" {tok};"))
            || squeezed.ends_with(&format!(" {tok}"))
            || squeezed.contains(&format!("\"{tok} "))
            || squeezed.contains(&format!("'{tok} "))
        {
            return Some("禁止关机/重启命令");
        }
    }
    if squeezed.contains("init 0")
        || squeezed.contains("init 6")
        || parts.first().copied() == Some("init")
            && matches!(parts.get(1).copied(), Some("0") | Some("6"))
    {
        return Some("禁止关机/重启命令");
    }

    // 10. Truncating critical system files via redirection
    let critical_files = [
        "/etc/passwd",
        "/etc/shadow",
        "/etc/sudoers",
        "/etc/fstab",
        "/etc/hosts",
        "/etc/ssh/sshd_config",
        "/boot/grub/grub.cfg",
    ];
    for cf in critical_files {
        let single_space = format!("> {cf}");
        let single_nospace = format!(">{cf}");
        let append_space = format!(">> {cf}");
        let append_nospace = format!(">>{cf}");
        let has_truncate = (normalized.contains(&single_space)
            && !normalized.contains(&append_space))
            || (normalized.contains(&single_nospace) && !normalized.contains(&append_nospace));
        if has_truncate {
            return Some("禁止覆盖关键系统文件");
        }
    }

    None
}
