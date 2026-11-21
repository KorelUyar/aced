// spurt-ocr: reads the text of a PDF whose pages are pictures or outlines (a scan, or a book
// saved from a web reader that draws its letters as shapes). Uses the text recognition built
// into macOS (Vision), on this Mac: nothing is sent anywhere.
//
//   spurt-ocr <file.pdf> [first-page] [last-page]
//
// Prints one line of JSON per page as it goes: {"page": 1, "total": 90, "text": "..."}
import Foundation
import PDFKit
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

let args = CommandLine.arguments
guard args.count >= 2, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
    FileHandle.standardError.write("cannot open the PDF\n".data(using: .utf8)!)
    exit(2)
}
let total = doc.pageCount
let first = max(1, args.count >= 3 ? Int(args[2]) ?? 1 : 1)
let last = min(total, args.count >= 4 ? Int(args[3]) ?? total : total)

func emit(_ page: Int, _ text: String) {
    let object: [String: Any] = ["page": page, "total": total, "text": text]
    if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

/// The page as a picture, about 2400 pixels on its long side: enough for small print.
func render(_ page: PDFPage) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { return nil }
    let scale = min(4.0, 2400 / max(bounds.width, bounds.height))
    let width = Int(bounds.width * scale), height = Int(bounds.height * scale)
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: -bounds.minX, y: -bounds.minY)
    page.draw(with: .mediaBox, to: context)
    return context.makeImage()
}

/// Lines in reading order. Vision gives boxes; pieces on the same height are one line, read
/// from the left, and lines are read from the top. Returns nil when recognition failed.
func recognise(_ image: CGImage, level: VNRequestTextRecognitionLevel, deadline: TimeInterval? = nil) -> String? {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["de-DE", "en-US", "fr-FR", "it-IT"]
    if level == .accurate, #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }

    var failed = false
    let work = { do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) } catch { failed = true } }
    if let deadline = deadline {
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async { work(); finished.signal() }
        if finished.wait(timeout: .now() + deadline) == .timedOut {
            request.cancel()
            return nil
        }
    } else {
        work()
    }
    if failed { return nil }

    var pieces: [(box: CGRect, text: String)] = []
    for observation in request.results ?? [] {
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

// macOS has two recognisers. The accurate one is tried first; on some systems it takes minutes
// to start or fails, and then the fast one (still good for printed text) does the whole file.
var level: VNRequestTextRecognitionLevel = .accurate
var probed = false

func read(_ image: CGImage) -> String {
    if level == .accurate {
        if let text = recognise(image, level: .accurate, deadline: probed ? 60 : 15) {
            probed = true
            return text
        }
        level = .fast
        FileHandle.standardError.write("the accurate recogniser is not usable here; using the fast one\n".data(using: .utf8)!)
    }
    return recognise(image, level: .fast) ?? ""
}

// For developers: SPURT_OCR_DEBUG=<folder> also saves each page's picture there.
let debugFolder = ProcessInfo.processInfo.environment["SPURT_OCR_DEBUG"]

for number in first...max(first, last) where number <= total {
    autoreleasepool {
        guard let page = doc.page(at: number - 1), let image = render(page) else { return emit(number, "") }
        if let folder = debugFolder,
           let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: "\(folder)/page-\(number).png") as CFURL, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(destination, image, nil)
            CGImageDestinationFinalize(destination)
        }
        emit(number, read(image))
    }
}
