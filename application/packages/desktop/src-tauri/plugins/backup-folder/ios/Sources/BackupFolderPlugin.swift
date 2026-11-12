import CryptoKit
import Foundation
import Network
import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

struct PlaceArgs: Decodable {
  let stagingPath: String
  let name: String
}

struct RefArgs: Decodable {
  let ref: String
}

/// A failure with the code the Rust side reads.
struct Failure: Error {
  let code: String
}

/// The backup folder on iOS.
///
/// The person picks a folder with the system picker. The app keeps bookmark
/// data for it and nothing else: it can reach that folder and no other place
/// outside its own container. Each use resolves the bookmark (and stores a
/// fresh one when the system says it went stale), opens the security scope,
/// and goes through NSFileCoordinator, so a provider such as iCloud Drive
/// sees the write. A backup is copied from the staging file in the app's
/// cache directory and then read back, so the Rust side (src/backup_dest.rs)
/// can compare what is stored with what it staged.
///
/// Reached from Rust only; the web view holds no permission for this plugin.
/// Rejections carry one code: `no-destination`, `bad-name`, `gone`,
/// `denied`, `full` or `io`.
/// Spec: docs/internal/plans/auto-backup.md (section 7)
class BackupFolderPlugin: Plugin, UIDocumentPickerDelegate {
  private static let bookmarkKey = "backup-folder.bookmark"
  private static let labelKey = "backup-folder.label"

  private let queue = DispatchQueue(label: "app.privacynotes.backupfolder")
  private let monitor = NWPathMonitor()
  private let defaults = UserDefaults.standard
  /// The pick that waits for the picker. Main thread only.
  private var pending: Invoke?

  override init() {
    super.init()
    // `currentPath` is only kept current while the monitor runs.
    monitor.start(queue: DispatchQueue(label: "app.privacynotes.backupfolder.network"))
  }

  @objc public func pick(_ invoke: Invoke) {
    DispatchQueue.main.async {
      // A picker that went away without a word must not hold the next one.
      self.answerPick(picked: false, label: "")
      guard let presenter = self.manager.viewController else {
        invoke.reject("No view to present from", code: "io")
        return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
      picker.delegate = self
      picker.allowsMultipleSelection = false
      self.pending = invoke
      presenter.present(picker, animated: true)
    }
  }

  private func answerPick(picked: Bool, label: String) {
    guard let invoke = pending else { return }
    pending = nil
    invoke.resolve(["picked": picked, "label": label])
  }

  public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let url = urls.first else {
      answerPick(picked: false, label: "")
      return
    }
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    guard let bookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
    else {
      guard let invoke = pending else { return }
      pending = nil
      invoke.reject("The folder cannot be kept", code: "denied")
      return
    }
    defaults.set(bookmark, forKey: Self.bookmarkKey)
    defaults.set(url.lastPathComponent, forKey: Self.labelKey)
    answerPick(picked: true, label: url.lastPathComponent)
  }

  public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    answerPick(picked: false, label: "")
  }

  @objc public func status(_ invoke: Invoke) {
    queue.async {
      guard self.defaults.data(forKey: Self.bookmarkKey) != nil else {
        invoke.resolve(["stored": false])
        return
      }
      let reachable = (try? self.withFolder { _ in true }) ?? false
      invoke.resolve([
        "stored": true,
        "label": self.defaults.string(forKey: Self.labelKey) ?? "",
        "reachable": reachable,
      ])
    }
  }

  @objc public func place(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PlaceArgs.self)
    queue.async {
      // A switch to another app must not cut the copy short.
      var task = UIBackgroundTaskIdentifier.invalid
      task = UIApplication.shared.beginBackgroundTask(withName: "backup-folder.place") {
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
      }
      defer {
        if task != .invalid {
          UIApplication.shared.endBackgroundTask(task)
        }
      }
      do {
        guard Self.validName(args.name) else { throw Failure(code: "bad-name") }
        // Only the staging file of src/backup_dest.rs is ever copied out.
        let staging = URL(fileURLWithPath: args.stagingPath).standardizedFileURL
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].standardizedFileURL
        guard staging.path.hasPrefix(caches.path + "/") else { throw Failure(code: "io") }
        let stored: (Int, String) = try self.withFolder { folder in
          let target = folder.appendingPathComponent(args.name, isDirectory: false)
          try self.coordinate(writing: target, options: .forReplacing) { actual in
            let files = FileManager.default
            if files.fileExists(atPath: actual.path) {
              try files.removeItem(at: actual)
            }
            try files.copyItem(at: staging, to: actual)
          }
          do {
            // What the folder holds now, not what was sent to it.
            return try self.hash(target)
          } catch {
            try? self.coordinate(writing: target, options: .forDeleting) { actual in
              try FileManager.default.removeItem(at: actual)
            }
            throw error
          }
        }
        invoke.resolve([
          "ref": args.name,
          "name": args.name,
          "bytes": stored.0,
          "sha256": stored.1,
        ])
      } catch {
        invoke.reject("Not placed", code: Self.code(of: error))
      }
    }
  }

  @objc public func exists(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(RefArgs.self)
    queue.async {
      do {
        guard Self.validName(args.ref) else { throw Failure(code: "bad-name") }
        let found = try self.withFolder { folder in
          Self.isRegularFile(folder.appendingPathComponent(args.ref, isDirectory: false))
        }
        invoke.resolve(["value": found == true])
      } catch {
        invoke.reject("Not checked", code: Self.code(of: error))
      }
    }
  }

  @objc public func delete(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(RefArgs.self)
    queue.async {
      do {
        guard Self.validName(args.ref) else { throw Failure(code: "bad-name") }
        let deleted: Bool = try self.withFolder { folder in
          let target = folder.appendingPathComponent(args.ref, isDirectory: false)
          switch Self.isRegularFile(target) {
          case nil:
            return false
          case false?:
            // A link or a folder at that name is not a backup of ours.
            throw Failure(code: "denied")
          default:
            try self.coordinate(writing: target, options: .forDeleting) { actual in
              try FileManager.default.removeItem(at: actual)
            }
            return true
          }
        }
        invoke.resolve(["value": deleted])
      } catch {
        invoke.reject("Not deleted", code: Self.code(of: error))
      }
    }
  }

  @objc public func clear(_ invoke: Invoke) {
    defaults.removeObject(forKey: Self.bookmarkKey)
    defaults.removeObject(forKey: Self.labelKey)
    invoke.resolve()
  }

  @objc public func metered(_ invoke: Invoke) {
    invoke.resolve(["value": monitor.currentPath.isExpensive])
  }

  /// Runs `body` with the stored folder, inside its security scope.
  /// `no-destination` when nothing is stored, `gone` when the bookmark no
  /// longer resolves or the folder cannot be reached now.
  private func withFolder<T>(_ body: (URL) throws -> T) throws -> T {
    guard let bookmark = defaults.data(forKey: Self.bookmarkKey) else {
      throw Failure(code: "no-destination")
    }
    var stale = false
    guard
      let folder = try? URL(
        resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    else {
      throw Failure(code: "gone")
    }
    // False for a folder that needs no scope; the reach check below decides.
    let scoped = folder.startAccessingSecurityScopedResource()
    defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
    if stale,
      let fresh = try? folder.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
    {
      defaults.set(fresh, forKey: Self.bookmarkKey)
    }
    var isFolder: ObjCBool = false
    guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isFolder), isFolder.boolValue else {
      throw Failure(code: "gone")
    }
    return try body(folder)
  }

  private func coordinate(
    writing url: URL, options: NSFileCoordinator.WritingOptions, _ body: (URL) throws -> Void
  ) throws {
    var coordination: NSError?
    var failure: Error?
    NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: options, error: &coordination) {
      actual in
      do {
        try body(actual)
      } catch {
        failure = error
      }
    }
    if let coordination = coordination { throw coordination }
    if let failure = failure { throw failure }
  }

  /// The size and SHA-256 (lower-case hex) of a file, read in pieces.
  private func hash(_ url: URL) throws -> (Int, String) {
    var coordination: NSError?
    var failure: Error?
    var result: (Int, String)?
    NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordination) {
      actual in
      do {
        let handle = try FileHandle(forReadingFrom: actual)
        defer { try? handle.close() }
        var hasher = SHA256()
        var bytes = 0
        while let piece = try handle.read(upToCount: 1 << 20), !piece.isEmpty {
          hasher.update(data: piece)
          bytes += piece.count
        }
        result = (bytes, hasher.finalize().map { String(format: "%02x", $0) }.joined())
      } catch {
        failure = error
      }
    }
    if let coordination = coordination { throw coordination }
    if let failure = failure { throw failure }
    guard let result = result else { throw Failure(code: "io") }
    return result
  }

  /// nil when nothing is at the path; false for a link, a folder or
  /// anything else that is not a regular file. A link is not followed.
  private static func isRegularFile(_ url: URL) -> Bool? {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else {
      return nil
    }
    return (attributes[.type] as? FileAttributeType) == .typeRegular
  }

  /// The same check as `device_of` in src/backup_dest.rs:
  /// `privacynotes-backup-YYYY-MM-DD-HHmm-<device>.(pnbackupz|pnbackup)`.
  static func validName(_ name: String) -> Bool {
    let bytes = Array(name.utf8)
    let prefix = Array("privacynotes-backup-".utf8)
    guard bytes.starts(with: prefix) else { return false }
    var rest = Array(bytes.dropFirst(prefix.count))
    let endings = [Array(".pnbackupz".utf8), Array(".pnbackup".utf8)]
    guard let ending = endings.first(where: { rest.count >= $0.count && rest.suffix($0.count).elementsEqual($0) })
    else { return false }
    rest.removeLast(ending.count)
    let stamp = Array("0000-00-00-0000-".utf8)
    guard rest.count > stamp.count, rest.count <= stamp.count + 40 else { return false }
    let digits: ClosedRange<UInt8> = 0x30...0x39
    for (have, want) in zip(rest, stamp) {
      if want == 0x30 ? !digits.contains(have) : have != want { return false }
    }
    return rest.dropFirst(stamp.count).allSatisfy { digits.contains($0) || (0x61...0x7a).contains($0) || $0 == 0x2d }
  }

  private static func code(of error: Error) -> String {
    if let failure = error as? Failure { return failure.code }
    var next: NSError? = error as NSError
    while let current = next {
      if current.domain == NSPOSIXErrorDomain {
        switch Int32(current.code) {
        case ENOSPC, EDQUOT: return "full"
        case EACCES, EPERM, EROFS: return "denied"
        case ENOENT, ENOTDIR: return "gone"
        default: break
        }
      }
      if current.domain == NSCocoaErrorDomain {
        switch current.code {
        case NSFileWriteOutOfSpaceError: return "full"
        case NSFileReadNoPermissionError, NSFileWriteNoPermissionError, NSFileWriteVolumeReadOnlyError: return "denied"
        case NSFileNoSuchFileError, NSFileReadNoSuchFileError: return "gone"
        default: break
        }
      }
      next = current.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return "io"
  }
}

@_cdecl("init_plugin_backup_folder")
func initPlugin() -> Plugin {
  return BackupFolderPlugin()
}
