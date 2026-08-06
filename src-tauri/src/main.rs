#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![cfg_attr(target_env = "msvc", allow(linker_messages))]

fn main() {
    if helm_lib::run_direct_broker_from_args() {
        return;
    }
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--no-proxy-server");
    helm_lib::run()
}
