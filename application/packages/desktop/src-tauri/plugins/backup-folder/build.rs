fn main() {
    // No command is listed, so no `allow-` permission is generated and no
    // capability can hand this plugin to the web view.
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .ios_path("ios")
        .build();
}
