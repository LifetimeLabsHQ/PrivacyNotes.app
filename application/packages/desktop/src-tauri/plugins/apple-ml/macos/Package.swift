// swift-tools-version:5.9
import PackageDescription

// macOS has no Tauri plugin class: build.rs links this library with swift-rs
// and src/macos.rs calls its @_cdecl functions.
let package = Package(
  name: "AppleMLMac",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "AppleMLMac", type: .static, targets: ["AppleMLMac"])
  ],
  dependencies: [
    .package(name: "SwiftRs", url: "https://github.com/Brendonovich/swift-rs", from: "1.0.0"),
    .package(name: "AppleMLCore", path: "../core"),
  ],
  targets: [
    .target(
      name: "AppleMLMac",
      dependencies: [.byName(name: "SwiftRs"), .product(name: "AppleMLCore", package: "AppleMLCore")],
      path: "Sources/AppleMLMac")
  ]
)
