mod api_server;
mod backup;
mod commands;
mod config;
mod crypto;
mod errors;
mod events;
mod http_client;
mod remote;
mod vault;

use commands::{
    api_server_logs, api_server_regenerate_key, api_server_start, api_server_status,
    api_server_stop, api_server_update_sessions, app_info, backup_record_delete,
    backup_record_restore, backup_records_clear, backup_run_now, check_update, config_snapshot,
    download_update, forward_list, forward_start_dynamic, forward_start_local,
    forward_start_remote, forward_stop, group_create, group_delete, group_update, install_update,
    local_expand_paths, local_path_exists, open_database_dir, open_external_url, open_path_dir,
    resolve_vault_path, session_create, session_delete, session_favorite_update,
    session_mark_recent, session_update, settings_update, sftp_close, sftp_copy, sftp_create_file,
    sftp_delete, sftp_list, sftp_mkdir, sftp_open, sftp_read_text, sftp_rename,
    sftp_resolve_target, sftp_search, sftp_write_text, spawn_auto_backup_scheduler, ssh_connect,
    ssh_disconnect, ssh_exec, ssh_exec_on_connection, ssh_trust_host_key, telemetry_snapshot,
    telemetry_start, telemetry_stop, terminal_close, terminal_open, terminal_resize,
    terminal_write, transfer_cancel, transfer_download, transfer_history_clear_finished,
    transfer_history_snapshot, transfer_pause, transfer_remove, transfer_resume, transfer_retry,
    transfer_upload, tunnel_create, tunnel_delete, tunnel_update, vault_backup_export,
    vault_backup_import, vault_migrate, vault_needs_migration, vault_skip_migration, AppState,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        log_window_result("show main window on frontend ready", window.show());
        log_window_result("focus main window on frontend ready", window.set_focus());
    }
    if let Some(window) = app.get_webview_window("splash") {
        log_window_result("close splash window", window.close());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("HelM".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log::LevelFilter::Info)
                .level_for("russh", log::LevelFilter::Warn)
                .level_for("russh::client", log::LevelFilter::Warn)
                .max_file_size(2 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .setup(|app| {
            let vault_path = resolve_vault_path(app.handle())?;
            let state = AppState::new(vault_path);
            // 启动死连接巡检：每 30s 扫描 SSH 连接表，把 russh keepalive_max 已经
            // 标记 closed 的僵尸连接清掉。修复"AI API 长跑后假死、必须手动重连"。
            // 注意：setup 闭包运行在主线程（非 Tokio 上下文），不能直接 tokio::spawn，
            // 需要通过 tauri::async_runtime::spawn 提交到 Tauri 管理的 Tokio runtime。
            let remote = state.remote().clone();
            let history_remote = remote.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = history_remote.load_transfer_history().await {
                    eprintln!("[helm] failed to load transfer history: {error}");
                }
            });
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                remote.spawn_dead_connection_reaper(app_handle);
            });
            app.manage(state);
            spawn_auto_backup_scheduler(app.handle().clone());
            configure_main_window(app);
            create_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            check_update,
            local_expand_paths,
            local_path_exists,
            download_update,
            install_update,
            open_database_dir,
            open_external_url,
            open_path_dir,
            frontend_ready,
            vault_needs_migration,
            vault_migrate,
            vault_skip_migration,
            config_snapshot,
            vault_backup_export,
            vault_backup_import,
            backup_run_now,
            backup_record_restore,
            backup_record_delete,
            backup_records_clear,
            settings_update,
            group_create,
            group_update,
            group_delete,
            session_create,
            session_update,
            session_favorite_update,
            session_mark_recent,
            session_delete,
            tunnel_create,
            tunnel_update,
            tunnel_delete,
            ssh_connect,
            ssh_disconnect,
            ssh_trust_host_key,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            ssh_exec,
            ssh_exec_on_connection,
            sftp_open,
            sftp_close,
            sftp_list,
            sftp_resolve_target,
            sftp_search,
            sftp_mkdir,
            sftp_create_file,
            sftp_delete,
            sftp_rename,
            sftp_copy,
            sftp_read_text,
            sftp_write_text,
            transfer_upload,
            transfer_download,
            transfer_cancel,
            transfer_history_snapshot,
            transfer_history_clear_finished,
            transfer_pause,
            transfer_resume,
            transfer_remove,
            transfer_retry,
            telemetry_start,
            telemetry_stop,
            telemetry_snapshot,
            forward_start_local,
            forward_start_remote,
            forward_start_dynamic,
            forward_stop,
            forward_list,
            api_server_start,
            api_server_stop,
            api_server_status,
            api_server_regenerate_key,
            api_server_logs,
            api_server_update_sessions
        ])
        .run(tauri::generate_context!())
        .expect("failed to run HelM");
}

fn configure_main_window(app: &mut tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        log_window_result("center main window", window.center());
        let close_window = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                log_window_result("hide main window on close request", close_window.hide());
            }
        });
    }
}

fn log_window_result<T, E: std::fmt::Display>(action: &str, result: Result<T, E>) {
    if let Err(error) = result {
        eprintln!("[helm] failed to {action}: {error}");
    }
}

fn create_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray_show", "显示主窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "tray_hide", "隐藏到托盘", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "tray_settings", "全局设置", true, None::<&str>)?;
    let backup = MenuItem::with_id(app, "tray_backup", "数据备份", true, None::<&str>)?;
    let backup_now = MenuItem::with_id(app, "tray_backup_now", "立即备份", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, "tray_exit", "退出程序", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &hide,
            &settings,
            &backup,
            &backup_now,
            &separator,
            &exit,
        ],
    )?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("HelM")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_main_window(app),
            "tray_hide" => hide_main_window(app),
            "tray_settings" => {
                show_main_window(app);
                crate::events::emit(app, crate::events::TRAY_ACTION, "settings");
            }
            "tray_backup" => {
                show_main_window(app);
                crate::events::emit(app, crate::events::TRAY_ACTION, "backup");
            }
            "tray_backup_now" => {
                show_main_window(app);
                crate::events::emit(app, crate::events::TRAY_ACTION, "backupNow");
            }
            "tray_exit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) {
            log_window_result("show main window", window.show());
        }
        if window.is_minimized().unwrap_or(false) {
            log_window_result("unminimize main window", window.unminimize());
        }
        // Windows 下 set_focus 不一定能把窗口拉到前台，先置顶再取消以强制前置
        #[cfg(target_os = "windows")]
        {
            log_window_result(
                "set main window always on top",
                window.set_always_on_top(true),
            );
            log_window_result(
                "unset main window always on top",
                window.set_always_on_top(false),
            );
        }
        log_window_result("focus main window", window.set_focus());
    }
}

fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        log_window_result("hide main window", window.hide());
    }
}
