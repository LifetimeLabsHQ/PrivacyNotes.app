import AppleMLCore
import Foundation
import SwiftRs

// Every export answers with one JSON envelope: {"ok": value} or
// {"err": "code"}. Each call blocks its thread: src/macos.rs runs it on a
// blocking thread, never on the main thread or an async worker.

private struct Ok<T: Encodable>: Encodable { let ok: T }
private struct Err: Encodable { let err: String }

private func envelope<T: Encodable>(_ body: () throws -> T) -> SRString {
  let enc = JSONEncoder()
  do {
    return SRString(String(decoding: try enc.encode(Ok(ok: try body())), as: UTF8.self))
  } catch let f as CoreFailure {
    return SRString(String(decoding: try! enc.encode(Err(err: f.code)), as: UTF8.self))
  } catch {
    return SRString(#"{"err":"io"}"#)
  }
}

private final class Box<T>: @unchecked Sendable { var value: Result<T, Error>? }

/// Runs async work to the end on a detached task and waits for it.
private func wait<T>(_ work: @escaping @Sendable () async throws -> T) throws -> T {
  let sem = DispatchSemaphore(value: 0)
  let box = Box<T>()
  Task.detached {
    do { box.value = .success(try await work()) } catch { box.value = .failure(error) }
    sem.signal()
  }
  sem.wait()
  return try box.value!.get()
}

/// An empty list lets Vision detect the language.
@_cdecl("apple_ml_ocr")
public func appleMlOcr(image: SRData, languages: SRString) -> SRString {
  envelope {
    let langs = languages.toString().split(separator: ",").map(String.init)
    return try recognizeText(Data(image.toArray()), languages: langs)
  }
}

// SpeechAnalyzer exists from macOS 26: an older Mac answers `os-too-old` and
// the web side uses Whisper.

@_cdecl("apple_ml_speech_status")
public func appleMlSpeechStatus(locale: SRString) -> SRString {
  let id = locale.toString()
  return envelope {
    guard #available(macOS 26, *) else { throw CoreFailure.code("os-too-old") }
    return try wait { await speechStatus(id) }
  }
}

@_cdecl("apple_ml_speech_install")
public func appleMlSpeechInstall(
  locale: SRString, context: UnsafeRawPointer?,
  progress: @convention(c) (UnsafeRawPointer?, Double) -> Void
) -> SRString {
  let id = locale.toString()
  let ctx = UInt(bitPattern: context)
  return envelope {
    guard #available(macOS 26, *) else { throw CoreFailure.code("os-too-old") }
    return try wait {
      try await speechInstall(id) { p in progress(UnsafeRawPointer(bitPattern: ctx), p) }
    }
  }
}

/// 16 kHz mono 16-bit PCM, in memory. `call` is Rust's number for it, which
/// `apple_ml_cancel` names.
@_cdecl("apple_ml_transcribe")
public func appleMlTranscribe(pcm: SRData, locale: SRString, call: UInt64) -> SRString {
  let audio = Data(pcm.toArray())
  let id = locale.toString()
  return envelope {
    guard #available(macOS 26, *) else { throw CoreFailure.code("os-too-old") }
    return try wait { try await transcribePCM(audio, locale: id, call: call) }
  }
}

/// Ends the running transcription `call`; it then answers `canceled`.
@_cdecl("apple_ml_cancel")
public func appleMlCancel(call: UInt64) -> Bool {
  cancelTranscription(call)
  return true
}
