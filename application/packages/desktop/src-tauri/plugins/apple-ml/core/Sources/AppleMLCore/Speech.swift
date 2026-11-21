import AVFoundation
import Foundation
import Speech

public struct SpeechSegment: Codable {
  public let text: String
  public let start: Double
  public let end: Double
}

public struct SpeechResult: Codable {
  public let text: String
  public let segments: [SpeechSegment]
  public let locale: String
}

/// What the OS says about the model for one locale: `unsupported`,
/// `supported` (the OS can fetch it), `downloading` or `installed`. `locale`
/// is the OS locale that matches the one asked for, empty when none does.
public struct SpeechStatus: Codable {
  public let locale: String
  public let status: String
}

@available(iOS 26, macOS 26, *)
func transcriberFor(_ identifier: String) async throws -> (DictationTranscriber, Locale) {
  guard
    let locale = await DictationTranscriber.supportedLocale(
      equivalentTo: Locale(identifier: identifier))
  else { throw CoreFailure.code("unsupported-locale") }
  // timeIndexedLongDictation: punctuation, and a time range on each run.
  return (DictationTranscriber(locale: locale, preset: .timeIndexedLongDictation), locale)
}

@available(iOS 26, macOS 26, *)
public func speechStatus(_ identifier: String) async -> SpeechStatus {
  guard let (t, locale) = try? await transcriberFor(identifier) else {
    return SpeechStatus(locale: "", status: "unsupported")
  }
  let name: String
  switch await AssetInventory.status(forModules: [t]) {
  case .unsupported: name = "unsupported"
  case .supported: name = "supported"
  case .downloading: name = "downloading"
  case .installed: name = "installed"
  @unknown default: name = "unsupported"
  }
  return SpeechStatus(locale: locale.identifier(.bcp47), status: name)
}

/// Asks the OS to fetch the model for the locale and returns once it is
/// installed; `progress` gets 0 to 1. Past the OS limit of reserved speech
/// languages this fails with `too-many`.
@available(iOS 26, macOS 26, *)
public func speechInstall(_ identifier: String, progress: @escaping (Double) -> Void) async throws
  -> SpeechStatus
{
  let (t, locale) = try await transcriberFor(identifier)
  let reserved = await AssetInventory.reservedLocales
  if !reserved.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }),
    reserved.count >= AssetInventory.maximumReservedLocales
  {
    throw CoreFailure.code("too-many")
  }
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
    let watch = request.progress.observe(\.fractionCompleted) { p, _ in progress(p.fractionCompleted) }
    defer { watch.invalidate() }
    do { try await request.downloadAndInstall() } catch { throw CoreFailure.code("install") }
  }
  return await speechStatus(identifier)
}

/// The one running transcription (Rust lets one run at a time), so a stopped
/// job ends it instead of letting it run to its end (beta #242 entry 2).
/// `call` is the number Rust gives each `transcribe`: a cancel that comes
/// before its call began still counts, and one for an older call does nothing.
final class RunningTranscription: @unchecked Sendable {
  private let lock = NSLock()
  private var call: UInt64 = 0
  private var stop: (() -> Void)?
  private var canceled: UInt64 = 0

  /// False when the call was canceled before it began.
  func begin(_ call: UInt64, stop: @escaping () -> Void) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if canceled == call { return false }
    self.call = call
    self.stop = stop
    return true
  }

  func end(_ call: UInt64) {
    lock.lock()
    defer { lock.unlock() }
    if self.call == call { stop = nil }
  }

  func cancel(_ call: UInt64) {
    lock.lock()
    canceled = call
    let run = self.call == call ? stop : nil
    if run != nil { stop = nil }
    lock.unlock()
    run?()
  }
}

let runningTranscription = RunningTranscription()

/// Ends the transcription Rust numbered `call`, if it still runs: it then
/// fails with `canceled`.
public func cancelTranscription(_ call: UInt64) {
  runningTranscription.cancel(call)
}

/// 16 kHz mono 16-bit PCM in memory (plugins.md D16: never a file), text
/// out. The model must be installed first: this never fetches it. The work
/// runs in a task the plugin holds, so `cancelTranscription` can end it.
@available(iOS 26, macOS 26, *)
public func transcribePCM(_ pcm: Data, locale identifier: String, call: UInt64) async throws -> SpeechResult {
  let task = Task { try await transcribeNow(pcm, locale: identifier) }
  guard runningTranscription.begin(call, stop: { task.cancel() }) else {
    task.cancel()
    throw CoreFailure.code("canceled")
  }
  defer { runningTranscription.end(call) }
  do {
    return try await task.value
  } catch {
    if task.isCancelled { throw CoreFailure.code("canceled") }
    throw error
  }
}

@available(iOS 26, macOS 26, *)
func transcribeNow(_ pcm: Data, locale identifier: String) async throws -> SpeechResult {
  try Task.checkCancellation()
  let (transcriber, locale) = try await transcriberFor(identifier)
  guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
    throw CoreFailure.code("model-missing")
  }
  // No format means no usable model, even when the status says installed
  // (the iOS Simulator answers so). macOS names 16 kHz mono Int16.
  guard let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
    let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: false),
    let converter = AVAudioConverter(from: source, to: target)
  else { throw CoreFailure.code("model-missing") }

  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
  let collector = Task { () throws -> [SpeechSegment] in
    var out: [SpeechSegment] = []
    for try await r in transcriber.results where r.isFinal {
      let text = String(r.text.characters).trimmingCharacters(in: .whitespaces)
      if text.isEmpty { continue }
      out.append(
        SpeechSegment(
          text: text, start: r.range.start.seconds,
          end: (r.range.start + r.range.duration).seconds))
    }
    return out
  }
  do {
    try await withTaskCancellationHandler {
      try await analyzer.start(inputSequence: stream)
      try feed(pcm, from: source, through: converter, to: target, into: input)
      input.finish()
      try await analyzer.finalizeAndFinishThroughEndOfInput()
    } onCancel: {
      // A stopped job: the analyzer drops what it holds and ends now.
      input.finish()
      Task { await analyzer.cancelAndFinishNow() }
    }
  } catch {
    input.finish()
    collector.cancel()
    if Task.isCancelled { throw CoreFailure.code("canceled") }
    // The OS message stays in the device log; the web side gets the code.
    NSLog("apple-ml speech failed: %@", String(describing: error))
    throw (error as? CoreFailure) ?? CoreFailure.code("speech")
  }
  let segments: [SpeechSegment]
  do { segments = try await collector.value } catch {
    if Task.isCancelled { throw CoreFailure.code("canceled") }
    NSLog("apple-ml speech results failed: %@", String(describing: error))
    throw CoreFailure.code("speech")
  }
  if Task.isCancelled { throw CoreFailure.code("canceled") }
  return SpeechResult(
    text: segments.map(\.text).joined(separator: " "), segments: segments,
    locale: locale.identifier(.bcp47))
}

/// Hands the PCM on one second at a time, converted to the analyzer's format.
@available(iOS 26, macOS 26, *)
func feed(
  _ pcm: Data, from source: AVAudioFormat, through converter: AVAudioConverter, to target: AVAudioFormat,
  into input: AsyncStream<AnalyzerInput>.Continuation
) throws {
  let frames = pcm.count / 2
  let chunk = 16_000
  let ratio = target.sampleRate / source.sampleRate
  var at = 0
  while at < frames {
    // An hour is 3600 rounds: a stop ends the loop between two of them.
    try Task.checkCancellation()
    let n = min(chunk, frames - at)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(n)),
      let channel = buffer.int16ChannelData?[0]
    else { throw CoreFailure.code("bad-audio") }
    pcm.withUnsafeBytes { raw in
      // Copy byte by byte: the body need not be aligned for Int16.
      _ = memcpy(channel, raw.baseAddress!.advanced(by: at * 2), n * 2)
    }
    buffer.frameLength = AVAudioFrameCount(n)
    at += n
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(n) * ratio) + 1024)
    else { throw CoreFailure.code("bad-audio") }
    var given = false
    var failure: NSError?
    let status = converter.convert(to: out, error: &failure) { _, state in
      if given {
        state.pointee = .noDataNow
        return nil
      }
      given = true
      state.pointee = .haveData
      return buffer
    }
    if status == .error {
      NSLog("apple-ml convert failed: %@", String(describing: failure))
      throw CoreFailure.code("bad-audio")
    }
    if out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
  }
}
