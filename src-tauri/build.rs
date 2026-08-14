#[cfg(windows)]
const WINDOWS_APP_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn main() {
    #[cfg(windows)]
    configure_windows_resources();

    #[cfg(not(windows))]
    tauri_build::build();
}

#[cfg(windows)]
fn configure_windows_resources() {
    use std::{env, fs, path::PathBuf};

    // Keep Tauri's icon and version resource, but link the application manifest
    // separately so it is also embedded in Rust's unit-test harness. Without a
    // Common Controls v6 manifest, tests importing TaskDialogIndirect fail to
    // start on Windows with STATUS_ENTRYPOINT_NOT_FOUND.
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("failed to run Tauri build script");

    let manifest_path = PathBuf::from(
        env::var_os("OUT_DIR").expect("missing OUT_DIR for Windows application manifest"),
    )
    .join("helm-app.manifest");
    fs::write(&manifest_path, WINDOWS_APP_MANIFEST)
        .expect("failed to write Windows application manifest");

    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
        manifest_path.display()
    );
}
