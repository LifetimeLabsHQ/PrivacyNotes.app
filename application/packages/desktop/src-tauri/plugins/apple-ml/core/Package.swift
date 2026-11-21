// swift-tools-version:5.9
import PackageDescription

// The engine calls, shared by the iOS plugin (../ios) and the macOS bridge
// (../macos). No Tauri and no UIKit here, so it builds for both.
let package = Package(
  name: "AppleMLCore",
  platforms: [.macOS(.v13), .iOS("17.4")],
  products: [
    .library(name: "AppleMLCore", targets: ["AppleMLCore"]),
  ],
  targets: [
    .target(name: "AppleMLCore", path: "Sources/AppleMLCore"),
  ]
)
