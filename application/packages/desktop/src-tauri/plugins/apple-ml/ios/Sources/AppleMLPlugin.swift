import AppleMLCore
import Foundation
import SwiftRs
import Tauri
import UIKit
import VisionKit
import WebKit

struct OcrArgs: Decodable {
  /// JSONDecoder reads a base64 string into Data.
  let image: Data
  let languages: [String]
}

struct LocaleArgs: Decodable {
  let locale: String
}

struct InstallArgs: Decodable {
  let locale: String
  let onProgress: Channel?
}

struct TranscribeArgs: Decodable {
  /// 16 kHz mono 16-bit PCM; JSONDecoder reads the base64 string into Data.
  let pcm: Data
  let locale: String
  /// Rust's number for this call, which `cancel` names.
  let call: UInt64
}

struct CancelArgs: Decodable {
  let call: UInt64
}

struct ScanArgs: Decodable {
  let quality: Double?
}

struct ScanResult: Encodable {
  /// The first page as a base64 JPEG: one page per scan (plugins.md D11).
  let page: String
  /// How many pages the camera took: it cannot be held to one, so the page
  /// says when the others were left out.
  let pages: Int
}

/// Apple's on-device engines on iOS, reached from Rust only (src/ios.rs).
/// Every input and output stays in memory: no temporary file (plugins.md D16).
/// Rejections carry one code: `bad-image`, `vision`, `unsupported`,
/// `unsupported-locale`, `model-missing`, `install`, `too-many`, `bad-audio`,
/// `speech`, `os-too-old`, `canceled`, `busy` or `io`.
class AppleMLPlugin: Plugin, VNDocumentCameraViewControllerDelegate {
  private var pendingScan: Invoke?
  private var scanQuality: CGFloat = 0.85

  /// The plugin manager's view controller stays empty in this app (measured
  /// 2026-11-18 on iPhone), and every plugin that shows a sheet presents from
  /// it: the opener's in-app browser did nothing, so no web link opened. The
  /// web view's own controller fills it, for all plugins.
  override func load(webview: WKWebView) {
    guard manager.viewController == nil else { return }
    var responder: UIResponder? = webview
    while let next = responder?.next {
      if let controller = next as? UIViewController {
        manager.viewController = controller
        return
      }
      responder = next
    }
    // Not in a window yet: once it is, its window's root.
    DispatchQueue.main.async { [weak webview, manager] in
      if manager.viewController == nil { manager.viewController = webview?.window?.rootViewController }
    }
  }

  private func fail(_ invoke: Invoke, _ error: Error) {
    let code = (error as? CoreFailure)?.code ?? "io"
    invoke.reject(code, code: code)
  }

  @objc public func ocr(_ invoke: Invoke) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let args = try invoke.parseArgs(OcrArgs.self)
        invoke.resolve(try recognizeText(args.image, languages: args.languages))
      } catch { self.fail(invoke, error) }
    }
  }

  @objc public func speechStatus(_ invoke: Invoke) {
    Task {
      guard #available(iOS 26, *) else { return invoke.reject("os-too-old", code: "os-too-old") }
      do {
        let args = try invoke.parseArgs(LocaleArgs.self)
        invoke.resolve(await AppleMLCore.speechStatus(args.locale))
      } catch { self.fail(invoke, error) }
    }
  }

  @objc public func speechInstall(_ invoke: Invoke) {
    Task {
      guard #available(iOS 26, *) else { return invoke.reject("os-too-old", code: "os-too-old") }
      do {
        let args = try invoke.parseArgs(InstallArgs.self)
        let status = try await AppleMLCore.speechInstall(args.locale) { p in
          try? args.onProgress?.send(["fraction": p])
        }
        invoke.resolve(status)
      } catch { self.fail(invoke, error) }
    }
  }

  @objc public func transcribe(_ invoke: Invoke) {
    Task {
      guard #available(iOS 26, *) else { return invoke.reject("os-too-old", code: "os-too-old") }
      do {
        let args = try invoke.parseArgs(TranscribeArgs.self)
        invoke.resolve(try await transcribePCM(args.pcm, locale: args.locale, call: args.call))
      } catch { self.fail(invoke, error) }
    }
  }

  /// Ends the running transcription; it then answers `canceled`.
  @objc public func cancel(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(CancelArgs.self) else { return invoke.reject("io", code: "io") }
    cancelTranscription(args.call)
    invoke.resolve()
  }

  @objc public func scan(_ invoke: Invoke) {
    let args = try? invoke.parseArgs(ScanArgs.self)
    DispatchQueue.main.async {
      // isSupported is false where the device has no camera (the Simulator).
      guard VNDocumentCameraViewController.isSupported else {
        return invoke.reject("unsupported", code: "unsupported")
      }
      guard self.pendingScan == nil else { return invoke.reject("busy", code: "busy") }
      guard let presenter = sheetPresenter(self.manager) else {
        return invoke.reject("io", code: "io")
      }
      // A sheet, a picker or a camera still on its way out: UIKit would not
      // present the camera, no delegate call would come, and the slot would
      // stay taken for the life of the app.
      guard presenter.presentedViewController == nil else {
        return invoke.reject("busy", code: "busy")
      }
      self.pendingScan = invoke
      self.scanQuality = CGFloat(args?.quality ?? 0.85)
      let camera = VNDocumentCameraViewController()
      camera.delegate = self
      presenter.present(camera, animated: true)
    }
  }

  /// Answers once the camera is gone: until then a new scan finds the slot
  /// taken and answers `busy`.
  private func finishScan(_ controller: VNDocumentCameraViewController, _ answer: @escaping (Invoke) -> Void) {
    controller.dismiss(animated: true) {
      if let invoke = self.pendingScan {
        self.pendingScan = nil
        answer(invoke)
      }
    }
  }

  func documentCameraViewController(
    _ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan
  ) {
    guard scan.pageCount > 0,
      let jpeg = scan.imageOfPage(at: 0).jpegData(compressionQuality: scanQuality)
    else {
      return finishScan(controller) { $0.reject("io", code: "io") }
    }
    let pages = scan.pageCount
    finishScan(controller) { $0.resolve(ScanResult(page: jpeg.base64EncodedString(), pages: pages)) }
  }

  func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
    finishScan(controller) { $0.reject("canceled", code: "canceled") }
  }

  func documentCameraViewController(
    _ controller: VNDocumentCameraViewController, didFailWithError error: Error
  ) {
    finishScan(controller) { $0.reject("io", code: "io") }
  }
}

/// The view to present a system sheet from. Tauri hands its view controller
/// to the plugin manager when the web view starts, but in the app's build the
/// manager these plugins see stays empty (`manager.viewController` is nil on
/// iPhone, measured 2026-11-18), so the key window's root stands in.
private func sheetPresenter(_ manager: PluginManager) -> UIViewController? {
  manager.viewController
    ?? UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)?.rootViewController
}

@_cdecl("init_plugin_apple_ml")
func initPlugin() -> Plugin {
  return AppleMLPlugin()
}
