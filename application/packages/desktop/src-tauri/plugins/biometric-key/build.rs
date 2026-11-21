fn main() {
    tauri_plugin::Builder::new(&["create", "open", "delete", "deviceCreate", "deviceOpen"])
        .android_path("android")
        .build();
}
