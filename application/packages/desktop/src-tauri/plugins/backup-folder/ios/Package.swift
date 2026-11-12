// swift-tools-version:5.5

import PackageDescription

// The library carries the Cargo package's name: the build script links it by
// that name. The app's own floor is iOS 17.4; 14 is what this code needs.
let package = Package(
  name: "tauri-plugin-backup-folder",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-backup-folder",
      type: .static,
      targets: ["tauri-plugin-backup-folder"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-backup-folder",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
