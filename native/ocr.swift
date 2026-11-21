// spurt-ocr: reads the text of a PDF whose pages are pictures or outlines (a scan, or a book
// saved from a web reader that draws its letters as shapes). Uses the text recognition built
// into macOS (Vision), on this Mac: nothing is sent anywhere.
//
//   spurt-ocr <file.pdf> [first-page] [last-page]
//   spurt-ocr --prepare          only gets the recogniser ready (see below), reads nothing
//
// Prints one line of JSON per step, as it goes:
//   {"page":0,"total":90}                           at once: the file is open, nothing is read yet
//   {"page":0,"total":90,"preparing":true}          every two seconds while macOS gets its recogniser ready
//   {"page":0,"total":90,"recogniser":"accurate"}   which recogniser reads this file: "accurate" or "fast"
//   {"page":1,"total":90,"text":"..."}              then every page
// A line without "text" only says where the work stands.
import CoreText
import Foundation
import PDFKit
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

let args = CommandLine.arguments
let onlyPrepare = args.count == 2 && args[1] == "--prepare"
let doc = args.count >= 2 && !onlyPrepare ? PDFDocument(url: URL(fileURLWithPath: args[1])) : nil
guard onlyPrepare || doc != nil else {
    FileHandle.standardError.write("cannot open the PDF\n".data(using: .utf8)!)
    exit(2)
}
let total = doc?.pageCount ?? 0
let first = max(1, args.count >= 3 ? Int(args[2]) ?? 1 : 1)
let last = min(total, args.count >= 4 ? Int(args[3]) ?? total : total)

func emit(_ page: Int, _ more: [String: Any] = [:]) {
    let object = more.merging(["page": page, "total": total]) { $1 }
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

func whiteCanvas(_ width: Int, _ height: Int) -> CGContext? {
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context
}

/// The page as a picture, about `longSide` pixels on its long side.
func render(_ page: PDFPage, longSide: CGFloat) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { return nil }
    let scale = min(4.0, longSide / max(bounds.width, bounds.height))
    guard let context = whiteCanvas(Int(bounds.width * scale), Int(bounds.height * scale)) else { return nil }
    // a scan is usually smaller than this and gets enlarged: smoothly, not in blocks
    context.interpolationQuality = .high
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: -bounds.minX, y: -bounds.minY)
    page.draw(with: .mediaBox, to: context)
    return context.makeImage()
}

/// A small picture with one line of print: what a recogniser is tried on before the file.
let sampleWord = "pages"
func sample() -> CGImage? {
    guard let context = whiteCanvas(900, 120) else { return nil }
    let text = NSAttributedString(string: "Reading the \(sampleWord) 12 and 34", attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, 44, nil),
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1),
    ])
    context.textPosition = CGPoint(x: 40, y: 42)
    CTLineDraw(CTLineCreateWithAttributedString(text), context)
    return context.makeImage()
}

/// Runs text recognition on one picture and waits for it. That can take long once: the first
/// time this helper uses the accurate recogniser (and again after an update of the helper or of
/// macOS), macOS builds its models, about a minute on the Mac this was measured on, and keeps
/// them. `waiting` is called every two seconds meanwhile, so the app sees that work goes on.
/// Returns nil when recognition failed, or was given up after `limit` seconds.
func recognise(_ image: CGImage, level: VNRequestTextRecognitionLevel, limit: TimeInterval, waiting: () -> Void) -> [VNRecognizedTextObservation]? {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level
    request.usesLanguageCorrection = true
    // German and English first; the four share one set of models.
    request.recognitionLanguages = ["de-DE", "en-US", "fr-FR", "it-IT"]
    // automaticallyDetectsLanguage stays off. With it, macOS builds a second set of models the
    // first time a page looks like another script (a line of formulas is enough): a stall of a
    // minute in the middle of a book, and brackets and minus signs read as Chinese ones.

    let finished = DispatchSemaphore(value: 0)
    var failed = false
    DispatchQueue.global(qos: .userInitiated).async {
        do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) } catch { failed = true }
        finished.signal()
    }
    let start = Date()
    var givenUp = false
    while finished.wait(timeout: .now() + 2) == .timedOut {
        let waited = Date().timeIntervalSince(start)
        if !givenUp, waited > limit {
            // Vision stops at its next pause, not at once; another request would wait behind this one.
            request.cancel()
            givenUp = true
        }
        if givenUp, waited > limit + 60 { return nil }
        waiting()
    }
    return givenUp || failed ? nil : request.results
}

/// Lines in reading order. Vision gives boxes; pieces on the same height are one line, read
/// from the left, and lines are read from the top.
func lines(_ observations: [VNRecognizedTextObservation]) -> String {
    var pieces: [(box: CGRect, text: String)] = []
    for observation in observations {
        if let best = observation.topCandidates(1).first { pieces.append((observation.boundingBox, best.string)) }
    }
    pieces.sort { $0.box.midY > $1.box.midY }
    var lines: [[(box: CGRect, text: String)]] = []
    for piece in pieces {
        if let lastLine = lines.last, let anchor = lastLine.first, abs(anchor.box.midY - piece.box.midY) < min(anchor.box.height, piece.box.height) * 0.5 {
            lines[lines.count - 1].append(piece)
        } else {
            lines.append([piece])
        }
    }
    return lines.map { line in line.sorted { $0.box.minX < $1.box.minX }.map { $0.text }.joined(separator: "  ") }.joined(separator: "\n")
}

// Only in a developer build (swiftc -D DEBUG): SPURT_OCR_DEBUG=<folder> also saves each page's
// picture there, and SPURT_OCR_LEVEL=fast skips the accurate recogniser. The helper that ships
// takes no settings and cannot be told to write files anywhere.
#if DEBUG
let debugFolder = ProcessInfo.processInfo.environment["SPURT_OCR_DEBUG"]
let onlyFast = ProcessInfo.processInfo.environment["SPURT_OCR_LEVEL"] == "fast"
#else
let debugFolder: String? = nil
let onlyFast = false
#endif

emit(0)

// macOS has two recognisers. Which one reads this file is decided here, once, before the first
// page: the accurate one if it reads the sample, else the fast one (fine for clean print, weak
// on small or pale print). Never the one for some pages and the other for the rest: an earlier
// version gave the accurate one 15 to 60 seconds per page, then stopped it and switched, so
// the same book came out well or badly depending on whether macOS had its models ready (and
// stopping it threw away the model macOS was building, so the next run waited again).
let patience: TimeInterval = 300
var level = VNRequestTextRecognitionLevel.fast
if !onlyFast, let picture = sample(), let read = recognise(picture, level: .accurate, limit: patience, waiting: { emit(0, ["preparing": true]) }),
   lines(read).contains(sampleWord) {
    level = .accurate
} else if !onlyFast {
    FileHandle.standardError.write("the accurate recogniser is not usable here; the fast one reads this file\n".data(using: .utf8)!)
}
emit(0, ["recogniser": level == .accurate ? "accurate" : "fast"])

// Measured on scans and on drawn pages: the accurate recogniser reads as well at 2400 pixels
// as at more; the fast one finds a few more exercise numbers at 3200 (and is unusable below 1600).
let longSide: CGFloat = level == .accurate ? 2400 : 3200

for number in first...max(first, last) where number <= total {
    autoreleasepool {
        guard let page = doc?.page(at: number - 1), let image = render(page, longSide: longSide) else { return emit(number, ["text": ""]) }
        if let folder = debugFolder,
           let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: "\(folder)/page-\(number).png") as CFURL, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(destination, image, nil)
            CGImageDestinationFinalize(destination)
        }
        // A page that cannot be read stays empty; the pages after it are read the same way as before.
        let read = recognise(image, level: level, limit: patience, waiting: { emit(number - 1) })
        emit(number, ["text": read.map(lines) ?? ""])
    }
}
