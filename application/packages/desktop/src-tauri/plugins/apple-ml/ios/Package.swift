// swift-tools-version:5.9
import PackageDescription

// The library carries the Cargo package's name: tauri-plugin's build script
// links it by that name for the iOS targets.
let package = Package(
  name: "tauri-plugin-apple-ml",
  platforms: [.iOS("17.4")],
  products: [
    .library(name: "tauri-plugin-apple-ml", type: .static, targets: ["tauri-plugin-apple-ml"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api"),
    .package(name: "AppleMLCore", path: "../core"),
  ],
  targets: [
    .target(
      name: "tauri-plugin-apple-ml",
      dependencies: [.byName(name: "Tauri"), .product(name: "AppleMLCore", package: "AppleMLCore")],
      path: "Sources")
  ]
)
