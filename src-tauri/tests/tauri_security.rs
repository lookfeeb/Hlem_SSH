use serde_json::Value;

#[test]
fn csp_allows_configurable_loopback_api_ports() {
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("tauri.conf.json should be valid JSON");
    let csp = config
        .pointer("/app/security/csp")
        .and_then(Value::as_str)
        .expect("Tauri CSP should be configured");
    let connect_src = csp
        .split(';')
        .map(str::trim)
        .find(|directive| directive.starts_with("connect-src "))
        .expect("Tauri CSP should define connect-src");

    assert!(
        connect_src
            .split_whitespace()
            .any(|source| source == "http://127.0.0.1:*"),
        "connect-src must allow the user-configurable loopback API port"
    );
}
