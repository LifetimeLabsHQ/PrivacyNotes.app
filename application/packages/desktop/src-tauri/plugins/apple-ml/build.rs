const COMMANDS: &[&str] = &["ocr", "scan", "speech_status", "speech_install", "transcribe", "cancel"];

fn main() {
    // iOS: tauri-plugin builds ios/ (product "tauri-plugin-apple-ml") with
    // swift-rs and copies the Tauri Swift API into .tauri/tauri-api.
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();

    // macOS: Tauri has no native plugin class on desktop, so link the bridge
    // package ourselves. SDKROOT is cleared the way tauri-utils does it, or
    // swift build picks the wrong SDK when cargo runs under Xcode.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let sdk_root = std::env::var_os("SDKROOT");
        std::env::remove_var("SDKROOT");
        swift_rs::SwiftLinker::new(
            &std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "13.0".into()),
        )
        .with_package("AppleMLMac", "macos")
        .link();
        if let Some(root) = sdk_root {
            std::env::set_var("SDKROOT", root);
        }
    }
    // tauri-plugin watches only the files it copies, so a Swift edit would
    // not rebuild the package without these lines.
    for dir in ["core/Sources", "ios/Sources", "macos/Sources", "core/Package.swift", "ios/Package.swift", "macos/Package.swift"] {
        println!("cargo:rerun-if-changed={dir}");
    }
}
