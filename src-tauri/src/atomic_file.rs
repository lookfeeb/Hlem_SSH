use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::errors::{AppError, AppResult};

pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    create_parent(path)?;
    let temp_path = temp_path_for(path);
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temp_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

pub async fn write_atomic_async(path: &Path, bytes: &[u8]) -> AppResult<()> {
    create_parent_async(path).await?;
    let temp_path = temp_path_for(path);
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .await?;
        file.write_all(bytes).await?;
        file.sync_all().await?;
        drop(file);
        replace_file_async(&temp_path, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp_path).await;
    }
    result
}

pub async fn replace_file_async(source: &Path, target: &Path) -> AppResult<()> {
    #[cfg(windows)]
    {
        replace_file(source, target)
    }
    #[cfg(not(windows))]
    {
        tokio::fs::rename(source, target)
            .await
            .map_err(|error| AppError::Io(error.to_string()))
    }
}

/// Atomically move a completed staging file into place only when the target
/// does not exist. The source and target must be on the same filesystem.
pub async fn move_file_no_replace_async(source: &Path, target: &Path) -> AppResult<()> {
    #[cfg(windows)]
    {
        move_file_no_replace(source, target)
    }
    #[cfg(not(windows))]
    {
        tokio::fs::hard_link(source, target)
            .await
            .map_err(|error| AppError::Io(error.to_string()))?;
        tokio::fs::remove_file(source)
            .await
            .map_err(|error| AppError::Io(error.to_string()))
    }
}

fn create_parent(path: &Path) -> AppResult<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

async fn create_parent_async(path: &Path) -> AppResult<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| AppError::Io(error.to_string()))?;
    }
    Ok(())
}

fn temp_path_for(path: &Path) -> PathBuf {
    let mut file_name = path
        .file_name()
        .map(OsString::from)
        .unwrap_or_else(|| OsString::from("helm-data"));
    file_name.push(format!(".helm-{}.tmp", Uuid::new_v4()));
    path.with_file_name(file_name)
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> AppResult<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    move_file_windows(
        source,
        target,
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
    )
}

#[cfg(windows)]
fn move_file_no_replace(source: &Path, target: &Path) -> AppResult<()> {
    use windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;

    move_file_windows(source, target, MOVEFILE_WRITE_THROUGH)
}

#[cfg(windows)]
fn move_file_windows(source: &Path, target: &Path, flags: u32) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let target: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) };
    if result == 0 {
        return Err(AppError::Io(std::io::Error::last_os_error().to_string()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> AppResult<()> {
    fs::rename(source, target).map_err(|error| AppError::Io(error.to_string()))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn sync_atomic_write_replaces_existing_file_without_temp_artifacts() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.json");
        fs::write(&path, b"old").unwrap();

        write_atomic(&path, b"new").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn async_atomic_write_replaces_existing_file_without_temp_artifacts() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.json");
        tokio::fs::write(&path, b"old").await.unwrap();

        write_atomic_async(&path, b"new").await.unwrap();

        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"new");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn no_replace_move_succeeds_when_target_is_absent() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.part");
        let target = dir.path().join("target.bin");
        tokio::fs::write(&source, b"new").await.unwrap();

        move_file_no_replace_async(&source, &target).await.unwrap();

        assert!(!source.exists());
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"new");
    }

    #[tokio::test]
    async fn no_replace_move_preserves_an_existing_target() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.part");
        let target = dir.path().join("target.bin");
        tokio::fs::write(&source, b"new").await.unwrap();
        tokio::fs::write(&target, b"old").await.unwrap();

        assert!(move_file_no_replace_async(&source, &target).await.is_err());

        assert_eq!(tokio::fs::read(&source).await.unwrap(), b"new");
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"old");
    }
}
