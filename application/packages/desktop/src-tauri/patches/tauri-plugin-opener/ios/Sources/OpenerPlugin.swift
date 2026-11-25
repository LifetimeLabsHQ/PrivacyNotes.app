// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import Foundation
import SafariServices
import SwiftRs
import Tauri
import UIKit
import WebKit

struct OpenArgs: Decodable {
  let url: String
  let with: String?
}

/// Resolves the active view controller for presenting an in-app Safari sheet.
/// Tauri's `PluginManager.viewController` can stay nil in this app (2026-11-18
/// iPhone regression), so fall back to the key window's root view controller
/// and walk to the topmost presented controller.
private func sheetPresenter(_ manager: PluginManager) -> UIViewController? {
  var top =
    manager.viewController
    ?? UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)?.rootViewController
  while let presented = top?.presentedViewController, !presented.isBeingDismissed {
    top = presented
  }
  return top
}

class OpenerPlugin: Plugin {
  @objc public func open(_ invoke: Invoke) throws {
    do {
      let args = try invoke.parseArgs(OpenArgs.self)
      guard let url = URL(string: args.url) else {
        invoke.reject("Invalid URL")
        return
      }
      if args.with == "inAppBrowser" {
        let scheme = url.scheme?.lowercased()
        guard scheme == "http" || scheme == "https" else {
          invoke.reject("inAppBrowser requires an http or https URL")
          return
        }
        DispatchQueue.main.async {
          guard let presenter = sheetPresenter(self.manager) else {
            invoke.reject("No view controller available to present in-app browser")
            return
          }
          let safariVC = SFSafariViewController(url: url)
          presenter.present(safariVC, animated: true) {
            invoke.resolve()
          }
        }
        return
      }
      DispatchQueue.main.async {
        UIApplication.shared.open(url, options: [:]) { opened in
          if opened {
            invoke.resolve()
          } else {
            invoke.reject("System could not open URL")
          }
        }
      }
    } catch {
      invoke.reject(error.localizedDescription)
    }
  }
}

@_cdecl("init_plugin_opener")
func initPlugin() -> Plugin {
  return OpenerPlugin()
}
