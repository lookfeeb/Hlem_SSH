// Free up Vite's dev port (5177) before `npm run dev`.
//
// Replaces the previous PowerShell-based scripts/free-vite-port.mjs:
// only kills processes whose command line references the current
// working directory, so we don't disturb other projects' dev servers.

#[cfg(not(windows))]
fn main() {
    // Non-Windows hosts don't need cleanup; vite handles port reuse.
}

#[cfg(windows)]
fn main() {
    if let Err(error) = run() {
        eprintln!("[free-port] failed to free dev port: {error}");
    }
}

#[cfg(windows)]
const TARGET_PORT: u16 = 5177;

#[cfg(windows)]
fn run() -> std::io::Result<()> {
    use sysinfo::{Pid, System};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    let cwd = std::env::current_dir()?;
    let cwd_lower = cwd.to_string_lossy().to_lowercase();

    let mut pids: Vec<u32> = Vec::new();
    pids.extend(enum_owning_pids_v4(TARGET_PORT));
    pids.extend(enum_owning_pids_v6(TARGET_PORT));
    pids.sort_unstable();
    pids.dedup();

    if pids.is_empty() {
        return Ok(());
    }

    let system = System::new_all();

    for pid in pids {
        let Some(process) = system.process(Pid::from_u32(pid)) else {
            continue;
        };
        let cmdline = process
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if !cmdline.contains(&cwd_lower) {
            continue;
        }
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) else {
                eprintln!("[free-port] failed to open process {pid} for termination");
                continue;
            };
            if let Err(error) = TerminateProcess(handle, 1) {
                eprintln!("[free-port] failed to terminate pid {pid}: {error}");
            }
            if let Err(error) = CloseHandle(handle) {
                eprintln!("[free-port] failed to close process handle for pid {pid}: {error}");
            }
        }
    }

    Ok(())
}

#[cfg(windows)]
fn enum_owning_pids_v4(port: u16) -> Vec<u32> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows::Win32::Networking::WinSock::AF_INET;

    let mut size: u32 = 0;
    unsafe {
        GetExtendedTcpTable(
            None,
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
    }
    if size == 0 {
        return Vec::new();
    }

    let mut buf = vec![0u8; size as usize];
    let rc = unsafe {
        GetExtendedTcpTable(
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if rc != 0 {
        return Vec::new();
    }

    let table = unsafe { &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
    let n = table.dwNumEntries as usize;
    if n == 0 {
        return Vec::new();
    }
    let rows = unsafe { std::slice::from_raw_parts(table.table.as_ptr(), n) };
    rows.iter()
        .filter_map(|row| {
            let port_be = (row.dwLocalPort & 0xFFFF) as u16;
            (u16::from_be(port_be) == port).then_some(row.dwOwningPid)
        })
        .collect()
}

#[cfg(windows)]
fn enum_owning_pids_v6(port: u16) -> Vec<u32> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6TABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows::Win32::Networking::WinSock::AF_INET6;

    let mut size: u32 = 0;
    unsafe {
        GetExtendedTcpTable(
            None,
            &mut size,
            false,
            AF_INET6.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
    }
    if size == 0 {
        return Vec::new();
    }

    let mut buf = vec![0u8; size as usize];
    let rc = unsafe {
        GetExtendedTcpTable(
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
            false,
            AF_INET6.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if rc != 0 {
        return Vec::new();
    }

    let table = unsafe { &*(buf.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID) };
    let n = table.dwNumEntries as usize;
    if n == 0 {
        return Vec::new();
    }
    let rows = unsafe { std::slice::from_raw_parts(table.table.as_ptr(), n) };
    rows.iter()
        .filter_map(|row| {
            let port_be = (row.dwLocalPort & 0xFFFF) as u16;
            (u16::from_be(port_be) == port).then_some(row.dwOwningPid)
        })
        .collect()
}
