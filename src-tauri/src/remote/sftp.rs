use super::*;

pub(super) async fn search_remote_file_with_find(
    handle: &SshHandle,
    base_path: &str,
    keyword: &str,
) -> AppResult<Option<String>> {
    let command = build_remote_find_command(base_path, keyword);
    let result = exec_with_handle(handle, command, SFTP_REMOTE_SEARCH_TIMEOUT_MS).await?;
    if result.timed_out {
        return Ok(None);
    }
    Ok(result
        .stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(normalize_remote_path))
}

pub(super) fn build_remote_find_command(base_path: &str, keyword: &str) -> String {
    let pattern = format!("*{keyword}*");
    format!(
        "command -v find >/dev/null 2>&1 && find {} -iname {} -print -quit 2>/dev/null",
        shell_quote(&normalize_remote_path(base_path)),
        shell_quote(&pattern)
    )
}

pub(super) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) fn build_remote_mkdir_command(path: &str) -> String {
    remote_file_command(r#"mkdir -p -- "$1""#, &[normalize_remote_path(path)])
}

pub(super) fn build_remote_create_file_command(path: &str) -> String {
    remote_file_command(r#": > "$1""#, &[normalize_remote_path(path)])
}

pub(super) fn build_remote_delete_command(path: &str, recursive: bool) -> String {
    let script = if recursive {
        r#"[ -e "$1" ] || [ -L "$1" ] || { printf "%s\n" "路径不存在: $1" >&2; exit 1; }; rm -rf -- "$1""#
    } else {
        r#"[ -e "$1" ] || [ -L "$1" ] || { printf "%s\n" "路径不存在: $1" >&2; exit 1; }; if [ -d "$1" ] && [ ! -L "$1" ]; then rmdir -- "$1"; else rm -f -- "$1"; fi"#
    };
    remote_file_command(script, &[normalize_remote_path(path)])
}

pub(super) fn build_remote_rename_command(from: &str, to: &str) -> String {
    remote_file_command(
        r#"[ -e "$1" ] || [ -L "$1" ] || { printf "%s\n" "路径不存在: $1" >&2; exit 1; }; if [ -d "$2" ] && [ ! -L "$2" ]; then printf "%s\n" "目标已存在且是目录: $2" >&2; exit 1; fi; mv -- "$1" "$2""#,
        &[normalize_remote_path(from), normalize_remote_path(to)],
    )
}

pub(super) fn build_remote_copy_command(from: &str, to: &str) -> String {
    remote_file_command(
        r#"[ -e "$1" ] || [ -L "$1" ] || { printf "%s\n" "路径不存在: $1" >&2; exit 1; }; if [ -d "$1" ] && [ ! -L "$1" ]; then mkdir -p -- "$2" && cp -a -- "$1"/. "$2"/; else if [ -d "$2" ] && [ ! -L "$2" ]; then printf "%s\n" "目标已存在且是目录: $2" >&2; exit 1; fi; cp -a -- "$1" "$2"; fi"#,
        &[normalize_remote_path(from), normalize_remote_path(to)],
    )
}

fn remote_file_command(script: &str, args: &[String]) -> String {
    let mut command = format!("sh -lc {} sh", shell_quote(script));
    for arg in args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    command
}

pub(super) fn ensure_remote_file_command_success(
    result: ExecResult,
    action: &str,
) -> AppResult<()> {
    if result.timed_out {
        return Err(AppError::Remote(format!("{action}超时")));
    }
    if result.exit_status.unwrap_or(1) == 0 {
        return Ok(());
    }
    let detail = result
        .stderr
        .trim()
        .lines()
        .next()
        .or_else(|| result.stdout.trim().lines().next())
        .filter(|line| !line.is_empty())
        .unwrap_or("命令执行失败");
    Err(AppError::Remote(format!("{action}失败：{detail}")))
}

#[derive(Default)]
pub(super) struct OwnerLookup {
    users: HashMap<u32, String>,
    groups: HashMap<u32, String>,
}

pub(super) async fn resolve_owner_lookup(
    handle: &SshHandle,
    entries: &[DirEntry],
) -> AppResult<OwnerLookup> {
    let mut uids = HashSet::new();
    let mut gids = HashSet::new();
    for entry in entries {
        let metadata = entry.metadata();
        if metadata.user.is_none() {
            if let Some(uid) = metadata.uid {
                uids.insert(uid);
            }
        }
        if metadata.group.is_none() {
            if let Some(gid) = metadata.gid {
                gids.insert(gid);
            }
        }
    }
    if uids.is_empty() && gids.is_empty() {
        return Ok(OwnerLookup::default());
    }

    let user_args = join_numbers(uids);
    let group_args = join_numbers(gids);
    let command = format!(
        "sh -lc '{}{}'",
        if user_args.is_empty() {
            String::new()
        } else {
            format!("getent passwd {user_args} | awk -F: '\\''{{print \"u:\"$3\":\"$1}}'\\''; ")
        },
        if group_args.is_empty() {
            String::new()
        } else {
            format!("getent group {group_args} | awk -F: '\\''{{print \"g:\"$3\":\"$1}}'\\''")
        }
    );
    let result = exec_with_handle(handle, command, SFTP_OWNER_LOOKUP_TIMEOUT_MS).await?;
    let mut lookup = OwnerLookup::default();
    for line in result.stdout.lines() {
        let mut parts = line.splitn(3, ':');
        let kind = parts.next();
        let id = parts.next().and_then(|value| value.parse::<u32>().ok());
        let name = parts.next().filter(|value| !value.is_empty());
        match (kind, id, name) {
            (Some("u"), Some(id), Some(name)) => {
                lookup.users.insert(id, name.to_string());
            }
            (Some("g"), Some(id), Some(name)) => {
                lookup.groups.insert(id, name.to_string());
            }
            _ => {}
        }
    }
    Ok(lookup)
}

pub(super) fn join_numbers(values: HashSet<u32>) -> String {
    let mut values: Vec<u32> = values.into_iter().collect();
    values.sort_unstable();
    values
        .into_iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn remote_entry(
    parent: &str,
    name: String,
    metadata: FileAttributes,
    owner_lookup: &OwnerLookup,
) -> RemoteFileEntry {
    let file_type = sftp_file_type(metadata.file_type());
    let permissions = format!(
        "{}{}",
        match file_type {
            RemoteFileType::Directory => "d",
            RemoteFileType::Symlink => "l",
            _ => "-",
        },
        metadata.permissions()
    );
    let user = metadata
        .user
        .clone()
        .or_else(|| {
            metadata
                .uid
                .and_then(|uid| owner_lookup.users.get(&uid).cloned())
        })
        .unwrap_or_else(|| metadata.uid.map_or("-".to_string(), |uid| uid.to_string()));
    let group = metadata
        .group
        .clone()
        .or_else(|| {
            metadata
                .gid
                .and_then(|gid| owner_lookup.groups.get(&gid).cloned())
        })
        .unwrap_or_else(|| metadata.gid.map_or("-".to_string(), |gid| gid.to_string()));
    let owner = format!("{user}/{group}");
    RemoteFileEntry {
        key: join_remote_path(parent, &name),
        path: join_remote_path(parent, &name),
        name,
        file_type,
        size: metadata.len(),
        modified_at: metadata
            .modified()
            .ok()
            .map(system_time_rfc3339)
            .unwrap_or_default(),
        permissions,
        owner,
    }
}

pub(super) struct SearchEntry {
    pub(super) name: String,
    pub(super) path: String,
    pub(super) is_directory: bool,
}

pub(super) fn search_entry(parent: &str, name: String, metadata: FileAttributes) -> SearchEntry {
    let path = join_remote_path(parent, &name);
    let is_directory = matches!(
        sftp_file_type(metadata.file_type()),
        RemoteFileType::Directory
    );
    SearchEntry {
        name,
        path,
        is_directory,
    }
}

pub(super) fn sftp_file_type(kind: SftpFileType) -> RemoteFileType {
    match kind {
        SftpFileType::Dir => RemoteFileType::Directory,
        SftpFileType::File => RemoteFileType::File,
        SftpFileType::Symlink => RemoteFileType::Symlink,
        SftpFileType::Other => RemoteFileType::Other,
    }
}

pub(super) fn system_time_rfc3339(time: SystemTime) -> String {
    let datetime: DateTime<Utc> = time.into();
    datetime.to_rfc3339()
}

pub(super) fn normalize_remote_path(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

pub(super) fn ensure_not_root_path(path: &str, message: &str) -> AppResult<()> {
    if normalize_remote_path(path) == "/" {
        Err(AppError::InvalidInput(message.to_string()))
    } else {
        Ok(())
    }
}

pub(super) fn is_same_or_child_remote_path(parent: &str, candidate: &str) -> bool {
    let parent = normalize_remote_path(parent);
    let candidate = normalize_remote_path(candidate);
    parent == candidate || (parent != "/" && candidate.starts_with(&format!("{parent}/")))
}

pub(super) fn ensure_not_same_or_child_path(
    source: &str,
    target: &str,
    message: &str,
) -> AppResult<()> {
    if is_same_or_child_remote_path(source, target) {
        Err(AppError::InvalidInput(message.to_string()))
    } else {
        Ok(())
    }
}

pub(super) fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

pub(super) fn remote_base_name(path: &str) -> String {
    normalize_remote_path(path)
        .split('/')
        .rfind(|part| !part.is_empty())
        .unwrap_or_default()
        .to_string()
}

pub(super) fn resolve_remote_target_path(current_path: &str, value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return normalize_remote_path(current_path);
    }
    if trimmed.starts_with('/') {
        normalize_remote_path(trimmed)
    } else {
        normalize_remote_path(&join_remote_path(
            &normalize_remote_path(current_path),
            trimmed,
        ))
    }
}
