use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{plugin::TauriPlugin, Manager, Resource, Wry};
use windows_sys::Win32::{
    Foundation::{
        GetLastError, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND,
        WAIT_OBJECT_0,
    },
    System::Threading::{
        CreateEventExW, CreateMutexExW, OpenEventW, SetEvent, WaitForSingleObject,
        EVENT_MODIFY_STATE, INFINITE, SYNCHRONIZATION_SYNCHRONIZE,
    },
};

// Named kernel objects are shared across installation paths, versions and login
// sessions. Windows releases them even after a crash, with no stale lock file.
struct InstanceLock {
    _mutex: OwnedHandle,
    wake: Arc<OwnedHandle>,
    stopped: Arc<AtomicBool>,
}

impl Resource for InstanceLock {}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        // Wake the listener so its thread and event handle are also released.
        unsafe { SetEvent(self.wake.as_raw_handle()) };
    }
}

pub(crate) fn init() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("single-instance")
        .setup(|app, _| {
            let base = format!("Global\\{}-single-instance", app.config().identifier);
            let event_name = format!("{base}-activate");
            let Some(mutex) = acquire(&base)? else {
                notify_existing(&event_name);
                app.cleanup_before_exit();
                std::process::exit(0);
            };

            let wake = Arc::new(create_event(&event_name)?);
            let stopped = Arc::new(AtomicBool::new(false));
            let listener_wake = wake.clone();
            let listener_stopped = stopped.clone();
            let handle = app.clone();
            std::thread::Builder::new()
                .name("helm-instance-activation".into())
                .spawn(move || loop {
                    let result =
                        unsafe { WaitForSingleObject(listener_wake.as_raw_handle(), INFINITE) };
                    if result != WAIT_OBJECT_0 || listener_stopped.load(Ordering::Acquire) {
                        break;
                    }
                    let app = handle.clone();
                    crate::log_window_result(
                        "activate existing instance",
                        handle.run_on_main_thread(move || activate(&app)),
                    );
                })?;

            // Hold through asynchronous shutdown until Tauri's final cleanup.
            app.resources_table().add(InstanceLock {
                _mutex: mutex,
                wake,
                stopped,
            });
            Ok(())
        })
        .build()
}

fn activate(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<crate::commands::AppState>() else {
        return;
    };
    if state.is_shutting_down() {
        return;
    }
    // Preserve the frontend-ready handshake during rapid repeat launches.
    if state.frontend_ready.load(Ordering::Acquire) {
        crate::show_main_window(app);
    } else if let Some(splash) = app.get_webview_window("splash") {
        crate::log_window_result("show startup window", splash.show());
        crate::log_window_result("focus startup window", splash.set_focus());
    }
}

fn wide(name: &str) -> Vec<u16> {
    name.encode_utf16().chain(Some(0)).collect()
}

fn acquire(name: &str) -> io::Result<Option<OwnedHandle>> {
    let name = wide(name);
    // Presence is the lock; it has no thread ownership and is not inherited by
    // WebView2 or broker children. Minimal rights also work across elevation.
    let raw = unsafe {
        CreateMutexExW(
            std::ptr::null(),
            name.as_ptr(),
            0,
            SYNCHRONIZATION_SYNCHRONIZE,
        )
    };
    let error = unsafe { GetLastError() };
    if raw.is_null() {
        // Another account may deny access to its mutex. Still reject the new
        // instance rather than bypassing the machine-wide restriction.
        return if error == ERROR_ACCESS_DENIED {
            Ok(None)
        } else {
            Err(io::Error::from_raw_os_error(error as i32))
        };
    }
    // SAFETY: CreateMutexExW returned a valid, non-inherited owned handle.
    let mutex = unsafe { OwnedHandle::from_raw_handle(raw) };
    if error == ERROR_ALREADY_EXISTS {
        Ok(None)
    } else {
        Ok(Some(mutex))
    }
}

fn create_event(name: &str) -> io::Result<OwnedHandle> {
    let name = wide(name);
    // Auto-reset preserves an activation sent before the listener starts, and
    // coalesces repeated double-clicks without polling or opening extra windows.
    let raw = unsafe {
        CreateEventExW(
            std::ptr::null(),
            name.as_ptr(),
            0,
            SYNCHRONIZATION_SYNCHRONIZE | EVENT_MODIFY_STATE,
        )
    };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn notify_existing(name: &str) {
    let name = wide(name);
    // The owner may still be between mutex creation and event creation. Retry
    // briefly, but always exit even if the owner is hung or in another session.
    for _ in 0..40 {
        let raw = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
        if !raw.is_null() {
            let event = unsafe { OwnedHandle::from_raw_handle(raw) };
            unsafe { SetEvent(event.as_raw_handle()) };
            return;
        }
        if unsafe { GetLastError() } != ERROR_FILE_NOT_FOUND {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{process::Command, sync::Barrier};
    use windows_sys::Win32::Foundation::WAIT_TIMEOUT;

    const CHILD_TEST: &str = "single_instance::tests::mutex_child_probe";

    fn unique_name() -> String {
        format!("Global\\com.helm.desktop-test-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn mutex_child_probe() {
        let Ok(name) = std::env::var("HELM_TEST_INSTANCE_MUTEX") else {
            return;
        };
        let expected = std::env::var("HELM_TEST_INSTANCE_EXPECT_ACQUIRED").unwrap() == "1";
        let lock = acquire(&name).unwrap();
        assert_eq!(lock.is_some(), expected);
        if let Some(event_name) = std::env::var_os("HELM_TEST_INSTANCE_EVENT") {
            notify_existing(&event_name.to_string_lossy());
        }
        // Skip destructors to cover OS cleanup after abrupt process termination.
        std::process::exit(0);
    }

    fn probe_process(name: &str, expected: bool, event_name: Option<&str>) {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", CHILD_TEST, "--nocapture"])
            .env("HELM_TEST_INSTANCE_MUTEX", name)
            .env(
                "HELM_TEST_INSTANCE_EXPECT_ACQUIRED",
                if expected { "1" } else { "0" },
            );
        if let Some(event_name) = event_name {
            command.env("HELM_TEST_INSTANCE_EVENT", event_name);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "child failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn rejects_other_process_and_allows_restart_after_release() {
        let name = unique_name();
        let owner = acquire(&name).unwrap().expect("first instance");
        probe_process(&name, false, None);
        probe_process(&name, false, None);
        drop(owner);
        probe_process(&name, true, None);
        // The child exits without Drop; the kernel must still release its lock.
        assert!(acquire(&name).unwrap().is_some());
    }

    #[test]
    fn simultaneous_launches_have_only_one_owner() {
        let name = unique_name();
        let barrier = Arc::new(Barrier::new(16));
        let workers: Vec<_> = (0..16)
            .map(|_| {
                let name = name.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let lock = acquire(&name).unwrap();
                    barrier.wait();
                    lock
                })
            })
            .collect();
        let locks: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(locks.iter().filter(|lock| lock.is_some()).count(), 1);
    }

    #[test]
    fn second_process_signals_activation_before_listener_waits() {
        let name = unique_name();
        let event_name = format!("{name}-activate");
        let _owner = acquire(&name).unwrap().unwrap();
        let event = create_event(&event_name).unwrap();
        probe_process(&name, false, Some(&event_name));
        assert_eq!(
            unsafe { WaitForSingleObject(event.as_raw_handle(), 0) },
            WAIT_OBJECT_0
        );
        assert_eq!(
            unsafe { WaitForSingleObject(event.as_raw_handle(), 0) },
            WAIT_TIMEOUT
        );
    }

    #[test]
    fn activation_waits_for_owner_to_publish_event() {
        let name = unique_name();
        let sender_name = name.clone();
        let sender = std::thread::spawn(move || notify_existing(&sender_name));
        std::thread::sleep(Duration::from_millis(100));
        let event = create_event(&name).unwrap();
        sender.join().unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(event.as_raw_handle(), 0) },
            WAIT_OBJECT_0
        );
    }
}
