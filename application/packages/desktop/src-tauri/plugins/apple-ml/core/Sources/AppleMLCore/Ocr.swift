import Foundation
import ImageIO
import Vision

/// One line that Vision read. The box is normalized (0 to 1) with the origin
/// at the top left, so the web side can draw it over the image as it is.
public struct OcrLine: Codable {
  public let text: String
  public let confidence: Float
  public let x: Double
  public let y: Double
  public let w: Double
  public let h: Double
}

public struct OcrResult: Codable {
  public let lines: [OcrLine]
  public let width: Int
  public let height: Int
  public let ms: Int
  public let revision: Int
}

public enum CoreFailure: Error {
  case code(String)

  public var code: String {
    switch self { case .code(let c): return c }
  }
}

/// The largest picture Vision reads, in pixels: 100 million, more than a
/// 48 MP phone photo, and about 400 MB once decoded. A picture can come from
/// someone else, and its header can ask for a far larger bitmap
/// (beta #242 entry 6).
let maxPixels = 100_000_000

/// Image bytes in, lines out. Rust lets only JPEG, PNG, WebP, GIF, HEIC and
/// AVIF through, by their first bytes; the size is read before any decode.
/// Accurate level, language correction on, the languages in the order given
/// (BCP 47, for example "en-US", "ja-JP"), or detected when the list is
/// empty. Vision reads in list order: a Latin language first makes it read
/// Japanese as Latin noise. Runs on the calling thread.
public func recognizeText(_ data: Data, languages: [String]) throws -> OcrResult {
  let start = Date()
  guard let source = CGImageSourceCreateWithData(data as CFData, nil),
    let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
    let width = props[kCGImagePropertyPixelWidth] as? Int,
    let height = props[kCGImagePropertyPixelHeight] as? Int,
    width > 0, height > 0, width <= maxPixels / height,
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { throw CoreFailure.code("bad-image") }
  // EXIF orientation: a phone photo is often stored on its side.
  var orientation = CGImagePropertyOrientation.up
  if let raw = props[kCGImagePropertyOrientation] as? UInt32,
    let o = CGImagePropertyOrientation(rawValue: raw)
  {
    orientation = o
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  // An empty list asks Vision to detect the language (iOS 16, macOS 13).
  if languages.isEmpty {
    request.automaticallyDetectsLanguage = true
  } else {
    request.recognitionLanguages = languages
  }
  let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
  do { try handler.perform([request]) } catch { throw CoreFailure.code("vision") }

  let lines: [OcrLine] = (request.results ?? []).compactMap { obs in
    guard let top = obs.topCandidates(1).first else { return nil }
    let b = obs.boundingBox  // normalized, origin bottom left
    return OcrLine(
      text: top.string, confidence: top.confidence,
      x: b.minX, y: 1 - b.maxY, w: b.width, h: b.height)
  }
  return OcrResult(
    lines: lines, width: image.width, height: image.height,
    ms: Int(Date().timeIntervalSince(start) * 1000), revision: request.revision)
}
