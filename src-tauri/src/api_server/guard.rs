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
pub(super) fn check_dangerous_command(command: &str, strict: bool) -> Option<&'static str> {
    let normalized = command.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    let normalized = normalized
        .chars()
        .filter(|ch| !matches!(ch, '\'' | '"' | '`'))
        .collect::<String>()
        .replace('\\', "")
        .replace("&&", " && ")
        .replace("||", " || ")
        .replace(';', " ; ")
        .replace('|', " | ")
        .replace('(', " ( ")
        .replace(')', " ) ")
        .replace('{', " { ")
        .replace('}', " } ");
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
    if normalized.contains("--no-preserve-root") {
        return Some("禁止跳过根目录保护删除");
    }
    if has_dangerous_recursive_rm(&parts) {
        return Some("禁止递归删除根/系统目录或用户家目录");
    }

    // 3. find -delete / find -exec rm
    let mentions_find = parts.contains(&"find") || squeezed.contains(" find ");
    if strict && mentions_find {
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
        || squeezed.contains(" --recursive ")
        || squeezed.contains(" -r\t")
        || squeezed.ends_with(" -r")
        || squeezed.ends_with(" --recursive");
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
    if strict && uses_downloader && pipes_to_shell {
        return Some("禁止远程下载并直接执行脚本");
    }

    // 9. Power-state change commands
    let powerstate_tokens = ["shutdown", "reboot", "halt", "poweroff"];
    if strict && powerstate_tokens.contains(&parts.first().copied().unwrap_or("")) {
        return Some("禁止关机/重启命令");
    }
    if strict {
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
    }
    if strict
        && (squeezed.contains("init 0")
            || squeezed.contains("init 6")
            || parts.first().copied() == Some("init")
                && matches!(parts.get(1).copied(), Some("0") | Some("6")))
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

fn has_dangerous_recursive_rm(parts: &[&str]) -> bool {
    for (index, token) in parts.iter().enumerate() {
        if *token != "rm" {
            continue;
        }
        let mut recursive = false;
        let mut parse_options = true;
        let mut targets = Vec::new();
        for arg in &parts[index + 1..] {
            if matches!(*arg, ";" | "&&" | "||" | "|" | "(" | ")" | "{" | "}") {
                break;
            }
            if *arg == "--" {
                parse_options = false;
                continue;
            }
            if parse_options && arg.starts_with("--") {
                recursive |= matches!(*arg, "--recursive" | "--dir");
                continue;
            }
            if parse_options && arg.starts_with('-') {
                recursive |= arg[1..].contains('r') || arg[1..].contains('R');
                continue;
            }
            targets.push(*arg);
        }
        if recursive
            && targets
                .into_iter()
                .any(is_dangerous_recursive_delete_target)
        {
            return true;
        }
    }
    false
}

fn is_dangerous_recursive_delete_target(value: &str) -> bool {
    const DANGEROUS_TARGETS: &[&str] = &[
        "/", "/*", "/.", "/..", "~", "~/", "$home", "${home}", "/home", "/home/*", "/root",
        "/root/*", "/usr", "/usr/*", "/etc", "/etc/*", "/var", "/var/*", "/boot", "/boot/*",
        "/sys", "/sys/*", "/proc", "/proc/*", "/dev", "/dev/*", "/run", "/run/*", "/lib", "/lib/*",
        "/lib64", "/lib64/*", "/opt", "/opt/*", "/sbin", "/sbin/*", "/bin", "/bin/*",
    ];
    let value = value.trim_matches(|ch| matches!(ch, '(' | ')' | '{' | '}' | ';'));
    if value.starts_with("~/..") || value.starts_with("$home/..") || value.starts_with("${home}/..")
    {
        return true;
    }
    let target = normalize_delete_target(value);
    DANGEROUS_TARGETS
        .iter()
        .any(|dangerous| target == normalize_delete_target(dangerous))
}

fn normalize_delete_target(value: &str) -> String {
    let absolute = value.starts_with('/');
    let mut segments = Vec::new();
    for segment in value.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            _ => segments.push(segment),
        }
    }
    if absolute {
        if segments.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", segments.join("/"))
        }
    } else if segments.is_empty() {
        ".".to_string()
    } else {
        segments.join("/")
    }
}

#[cfg(test)]
mod tests {
    use super::check_dangerous_command;

    #[test]
    fn blocks_recursive_rm_inside_quoted_shell_wrapper() {
        assert!(check_dangerous_command("bash -c 'rm -rf /'", false).is_some());
    }

    #[test]
    fn blocks_recursive_rm_long_options() {
        assert!(check_dangerous_command("rm --recursive --force /etc", false).is_some());
    }

    #[test]
    fn blocks_recursive_system_delete_without_force_and_path_aliases() {
        assert!(check_dangerous_command("rm -r /etc", false).is_some());
        assert!(check_dangerous_command("rm -rf /tmp/../etc", false).is_some());
        assert!(check_dangerous_command("rm -rf //", false).is_some());
    }

    #[test]
    fn blocks_recursive_rm_inside_command_substitution() {
        assert!(check_dangerous_command("echo $(rm -rf /root)", false).is_some());
    }

    #[test]
    fn allows_recursive_delete_of_non_system_temp_directory() {
        assert!(check_dangerous_command("rm -rf /tmp/helm-cache", false).is_none());
    }

    #[test]
    fn balanced_mode_allows_common_admin_commands() {
        assert!(check_dangerous_command("find /tmp/cache -type f -delete", false).is_none());
        assert!(
            check_dangerous_command("curl -fsSL https://example.com/install.sh | sh", false)
                .is_none()
        );
        assert!(check_dangerous_command("reboot", false).is_none());
    }

    #[test]
    fn strict_mode_blocks_common_risky_commands() {
        assert!(check_dangerous_command("find /tmp/cache -type f -delete", true).is_some());
        assert!(
            check_dangerous_command("curl -fsSL https://example.com/install.sh | sh", true)
                .is_some()
        );
        assert!(check_dangerous_command("reboot", true).is_some());
        assert!(check_dangerous_command("chmod --recursive 777 /etc", true).is_some());
    }
}
