// aced-ocr: the part of Aced that uses macOS itself, on this Mac (nothing is sent anywhere).
//
//   aced-ocr <file.pdf> [first-page] [last-page]
//       reads the text of a PDF whose pages are pictures or outlines (a scan, or a book saved
//       from a web reader that draws its letters as shapes), with the text recognition built
//       into macOS (Vision)
//   aced-ocr --prepare
//       only gets the recogniser ready (see below), reads nothing
//   aced-ocr --info <picture>...
//       what each picture is: its size in pixels, how many pages it has, when it was taken
//   aced-ocr --images <out.pdf> <picture>...
//       one PDF with a page for every picture (for every page of a TIFF), in the order given
//   aced-ocr --render <file.pdf> <long-side> <out-folder> [first-page] [last-page]
//       every page as a JPEG of at most <long-side> pixels: what an AI that can see is shown
//   aced-ocr --sample <out.png>
//       a small picture with one line of print, to find out whether an AI can see
//   aced-ocr --clean <file.pdf> <out.pdf>
//       a copy to share: every page drawn anew, without the file's information and metadata
//   aced-ocr --can-share
//       which ways to send a file this Mac has set up: {"airdrop":true,"messages":false,"mail":true}
//   aced-ocr --share <airdrop|messages|mail> <file> [subject] [text]
//       hands the file to AirDrop, Messages or Mail (NSSharingService): prints {"opened":true} once
//       their window is up (or {"missing":true}), and {"done":"shared"|"cancelled"|"failed"} at the end
//   aced-ocr --copy-file <file>
//       puts the file on the clipboard the way the Finder does, to paste into WhatsApp, Mail …
//
// Prints one line of JSON per step, as it goes. For reading a PDF:
//   {"page":0,"total":90}                           at once: the file is open, nothing is read yet
//   {"page":0,"total":90,"preparing":true}          every two seconds while macOS gets its recogniser ready
//   {"page":0,"total":90,"recogniser":"accurate"}   which recogniser reads this file: "accurate" or "fast"
//   {"page":1,"total":90,"text":"..."}              then every page
// A line without "text" only says where the work stands.
import AppKit
import CoreText
import Foundation
import ImageIO
import PDFKit
import UniformTypeIdentifiers
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

func say(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

func fail(_ message: String, _ code: Int32 = 2) -> Never {
    FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
    exit(code)
}

func whiteCanvas(_ width: Int, _ height: Int) -> CGContext? {
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context
}

/// The page as a picture, about `longSide` pixels on its long side, and never more than
/// `most` pixels per point of the page.
func render(_ page: PDFPage, longSide: CGFloat, most: CGFloat = 4) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { return nil }
    let scale = min(most, longSide / max(bounds.width, bounds.height))
    guard let context = whiteCanvas(Int(bounds.width * scale), Int(bounds.height * scale)) else { return nil }
    // a scan is usually smaller than this and gets enlarged: smoothly, not in blocks
    context.interpolationQuality = .high
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: -bounds.minX, y: -bounds.minY)
    page.draw(with: .mediaBox, to: context)
    return context.makeImage()
}

func write(_ image: CGImage, to path: String, type: UTType, quality: Double = 0.86) -> Bool {
    guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, type.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(destination)
}

/// A small picture with one line of print: what a recogniser is tried on before the file, and
/// what an AI is shown to find out whether it can see.
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

// ------------------------------------------------------------ pictures

/// Larger pictures are not read: decoding one would take gigabytes. (A 48-megapixel photo is well below.)
let mostPixels = 120_000_000
/// The long side of a picture's page in the PDF, in pixels: enough for the book panel and for
/// reading, and a photo does not make the file huge.
let pageLongSide = 4096

struct Picture {
    let source: CGImageSource
    let width: Int
    let height: Int
    let indexes: [Int]
    let dpi: Double
    let lossless: Bool
}

func open(_ path: String) -> Picture? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    let count = CGImageSourceGetCount(source)
    guard count > 0 else { return nil }
    let type = (CGImageSourceGetType(source) as String?) ?? ""
    // Every page of a TIFF (a scanner writes several pages into one), the main picture of
    // anything else (the first frame of a GIF, the photo of a HEIC with its depth maps).
    let isTiff = UTType(type)?.conforms(to: .tiff) ?? false
    let primary = CGImageSourceGetPrimaryImageIndex(source)
    let indexes = isTiff ? Array(0..<count) : [primary < count ? primary : 0]
    guard let props = CGImageSourceCopyPropertiesAtIndex(source, indexes[0], nil) as? [CFString: Any] else { return nil }
    let width = (props[kCGImagePropertyPixelWidth] as? Int) ?? 0
    let height = (props[kCGImagePropertyPixelHeight] as? Int) ?? 0
    let dpi = (props[kCGImagePropertyDPIWidth] as? Double) ?? 72
    // Screenshots and drawings stay sharp; photos are stored as JPEG.
    let lossless = [UTType.png, UTType.gif, UTType.bmp].contains { UTType(type)?.conforms(to: $0) ?? false }
    return Picture(source: source, width: width, height: height, indexes: indexes, dpi: dpi, lossless: lossless)
}

/// When the picture was taken, from its EXIF data ("2026-11-22T12:40:15"), or nil.
func takenAt(_ picture: Picture) -> String? {
    guard let props = CGImageSourceCopyPropertiesAtIndex(picture.source, picture.indexes[0], nil) as? [CFString: Any],
          let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any],
          let value = (exif[kCGImagePropertyExifDateTimeOriginal] ?? exif[kCGImagePropertyExifDateTimeDigitized]) as? String else { return nil }
    let parts = value.split(whereSeparator: { $0 == ":" || $0 == " " })
    guard parts.count >= 6 else { return nil }
    return "\(parts[0])-\(parts[1])-\(parts[2])T\(parts[3]):\(parts[4]):\(parts[5])"
}

/// One page of a picture, turned upright as the camera recorded it and made no larger than `pageLongSide`.
func pageImage(_ picture: Picture, _ index: Int) -> CGImage? {
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: min(pageLongSide, max(picture.width, picture.height, 1)),
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(picture.source, index, options as CFDictionary) else { return nil }
    if picture.lossless { return image }
    // A JPEG-backed picture goes into the PDF as JPEG, not as raw pixels.
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return image }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
    guard CGImageDestinationFinalize(destination), let provider = CGDataProvider(data: data) else { return image }
    return CGImage(jpegDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) ?? image
}

func info(_ paths: [String]) {
    for (i, path) in paths.enumerated() {
        guard let picture = open(path) else {
            say(["file": i, "failed": "unreadable"])
            continue
        }
        var line: [String: Any] = ["file": i, "width": picture.width, "height": picture.height, "pages": picture.indexes.count]
        if let taken = takenAt(picture) { line["taken"] = taken }
        say(line)
    }
}

func images(_ out: String, _ paths: [String]) {
    guard let context = CGContext(URL(fileURLWithPath: out) as CFURL, mediaBox: nil, [kCGPDFContextCreator: "Aced"] as CFDictionary) else { fail("cannot write the PDF") }
    var pages = 0
    for (i, path) in paths.enumerated() {
        autoreleasepool {
            guard let picture = open(path) else { return say(["file": i, "failed": "unreadable"]) }
            guard picture.width > 0, picture.height > 0 else { return say(["file": i, "failed": "unreadable"]) }
            guard picture.width * picture.height <= mostPixels else {
                return say(["file": i, "failed": "large", "width": picture.width, "height": picture.height])
            }
            var added = 0
            for index in picture.indexes {
                guard let image = pageImage(picture, index) else { continue }
                // The page is as large as the picture would show on a screen: a screenshot at
                // its own size, a photo at a size that fits a page. Only the proportions matter
                // to the book panel, which fits a page to its width.
                let density = picture.dpi >= 100 ? picture.dpi : 144
                var w = Double(image.width) * 72 / density
                var h = Double(image.height) * 72 / density
                let long = max(w, h)
                let fit = long > 1400 ? 1400 / long : long < 400 ? 400 / long : 1
                w *= fit
                h *= fit
                var box = CGRect(x: 0, y: 0, width: w, height: h)
                context.beginPage(mediaBox: &box)
                context.interpolationQuality = .high
                context.draw(image, in: box)
                context.endPage()
                added += 1
            }
            pages += added
            say(added > 0 ? ["file": i, "pages": added] : ["file": i, "failed": "unreadable"])
        }
    }
    context.closePDF()
    say(["done": true, "pages": pages])
}

/// A copy of a PDF that says nothing about where it came from: every page is drawn anew into a
/// new PDF, so the document's information (author, title, the app that made it), its XMP
/// metadata, attachments, scripts, links and form fields stay behind. The text stays text and
/// every page stays (a page that cannot be drawn becomes an empty one, so the numbers still fit).
/// Pictures go along as they are; what a photo says about itself is blanked by the app.
func clean(_ file: String, _ out: String) {
    guard let doc = CGPDFDocument(URL(fileURLWithPath: file) as CFURL) else { fail("cannot open the PDF") }
    guard doc.isUnlocked, doc.numberOfPages > 0 else { fail("locked or empty") }
    guard let context = CGContext(URL(fileURLWithPath: out) as CFURL, mediaBox: nil, nil) else { fail("cannot write the PDF") }
    for n in 1...doc.numberOfPages {
        autoreleasepool {
            guard let page = doc.page(at: n) else {
                var box = CGRect(x: 0, y: 0, width: 595, height: 842)
                context.beginPage(mediaBox: &box)
                return context.endPage()
            }
            let crop = page.getBoxRect(.cropBox)
            let turned = abs(page.rotationAngle) % 180 == 90
            var box = CGRect(x: 0, y: 0, width: turned ? crop.height : crop.width, height: turned ? crop.width : crop.height)
            context.beginPage(mediaBox: &box)
            context.concatenate(page.getDrawingTransform(.cropBox, rect: box, rotate: 0, preserveAspectRatio: true))
            context.drawPDFPage(page)
            context.endPage()
        }
    }
    context.closePDF()
    say(["done": true, "pages": doc.numberOfPages])
}

func renderPages(_ file: String, _ longSide: CGFloat, _ folder: String, _ first: Int, _ last: Int) {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: file)) else { fail("cannot open the PDF") }
    let total = doc.pageCount
    for number in max(1, first)...max(1, min(last, total)) where number <= total {
        autoreleasepool {
            // Two pixels per point: a picture's own pixels (see `images`), a scanned page at 144
            // dpi. Enlarging further would only cost the AI more without showing it more.
            guard let page = doc.page(at: number - 1), let image = render(page, longSide: longSide, most: 2) else { return say(["page": number, "total": total, "failed": true]) }
            let path = "\(folder)/page-\(number).jpg"
            say(write(image, to: path, type: .jpeg) ? ["page": number, "total": total, "file": path, "width": image.width, "height": image.height] : ["page": number, "total": total, "failed": true])
        }
    }
}

// ------------------------------------------------------------ text recognition

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

// Only in a developer build (swiftc -D DEBUG): ACED_OCR_DEBUG=<folder> also saves each page's
// picture there, and ACED_OCR_LEVEL=fast skips the accurate recogniser. The helper that ships
// takes no settings and cannot be told to write files anywhere it is not asked to.
#if DEBUG
let debugFolder = ProcessInfo.processInfo.environment["ACED_OCR_DEBUG"]
let onlyFast = ProcessInfo.processInfo.environment["ACED_OCR_LEVEL"] == "fast"
#else
let debugFolder: String? = nil
let onlyFast = false
#endif

func readPdf(_ doc: PDFDocument?, first: Int, last: Int) {
    let total = doc?.pageCount ?? 0
    func emit(_ page: Int, _ more: [String: Any] = [:]) {
        say(more.merging(["page": page, "total": total]) { $1 })
    }
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
            if let folder = debugFolder { _ = write(image, to: "\(folder)/page-\(number).png", type: .png) }
            // A page that cannot be read stays empty; the pages after it are read the same way as before.
            let read = recognise(image, level: level, limit: patience, waiting: { emit(number - 1) })
            emit(number, ["text": read.map(lines) ?? ""])
        }
    }
}

// ------------------------------------------------------------ sending a file (Aced's share window)

/// The ways to send a file that the share window offers, by the names macOS knows them by.
let sendWays: [String: NSSharingService.Name] = ["airdrop": .sendViaAirDrop, "messages": .composeMessage, "mail": .composeEmail]

/// A way that this Mac has, and that takes the file (a way that is not set up is not offered by macOS).
func sendService(_ way: String, _ items: [Any]) -> NSSharingService? {
    guard let name = sendWays[way], let service = NSSharingService(named: name), service.canPerform(withItems: items) else { return nil }
    return service
}

func canShare() {
    _ = NSApplication.shared
    let probe = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("aced-probe-\(getpid()).aced")
    FileManager.default.createFile(atPath: probe.path, contents: Data("aced".utf8))
    defer { try? FileManager.default.removeItem(at: probe) }
    var out: [String: Any] = [:]
    for way in sendWays.keys { out[way] = sendService(way, [probe]) != nil }
    say(out)
}

/// Runs as a small app without a Dock icon while AirDrop, Messages or Mail shows its window.
final class Sender: NSObject, NSApplicationDelegate, NSSharingServiceDelegate {
    let service: NSSharingService
    let items: [Any]
    init(_ service: NSSharingService, _ items: [Any]) {
        self.service = service
        self.items = items
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        service.delegate = self
        NSApp.activate(ignoringOtherApps: true)
        service.perform(withItems: items)
        // (macOS shows AirDrop and Messages over the whole screen, dimmed, in front of every app)
        say(["opened": true])
        // Nobody answers for a quarter of an hour: the helper ends; macOS keeps what it was given.
        DispatchQueue.main.asyncAfter(deadline: .now() + 900) { exit(0) }
    }
    func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) {
        say(["done": "shared"])
        exit(0)
    }
    func sharingService(_ sharingService: NSSharingService, didFailToShareItems items: [Any], error: Error) {
        let e = error as NSError
        say(["done": e.domain == NSCocoaErrorDomain && e.code == NSUserCancelledError ? "cancelled" : "failed"])
        exit(0)
    }
}

func share(_ way: String, _ file: String, subject: String?, text: String?) {
    let url = URL(fileURLWithPath: file)
    guard FileManager.default.isReadableFile(atPath: url.path) else { fail("cannot read the file") }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    // Mail takes a subject and a line of text with the file; AirDrop and Messages only the file.
    var items: [Any] = [url]
    if way == "mail", let text = text, !text.isEmpty { items.insert(text, at: 0) }
    guard let service = sendService(way, items) else {
        say(["missing": true])
        exit(0)
    }
    if way == "mail", let subject = subject { service.subject = subject }
    let sender = Sender(service, items)
    app.delegate = sender
    app.run()
}

func copyFile(_ file: String) {
    let url = URL(fileURLWithPath: file)
    guard FileManager.default.isReadableFile(atPath: url.path) else { fail("cannot read the file") }
    let board = NSPasteboard.general
    board.clearContents()
    guard board.writeObjects([url as NSURL]) else { fail("cannot write to the clipboard") }
    say(["copied": true])
}

// ------------------------------------------------------------ what was asked for

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "--prepare" where args.count == 1:
    readPdf(nil, first: 1, last: 0)
case "--info" where args.count >= 2:
    info(Array(args.dropFirst()))
case "--images" where args.count >= 3:
    images(args[1], Array(args.dropFirst(2)))
case "--render" where args.count >= 4:
    renderPages(args[1], CGFloat(Double(args[2]) ?? 2000), args[3], args.count >= 5 ? Int(args[4]) ?? 1 : 1, args.count >= 6 ? Int(args[5]) ?? Int.max : Int.max)
case "--clean" where args.count == 3:
    clean(args[1], args[2])
case "--can-share" where args.count == 1:
    canShare()
case "--share" where args.count >= 3 && args.count <= 5 && sendWays[args[1]] != nil:
    share(args[1], args[2], subject: args.count >= 4 ? args[3] : nil, text: args.count >= 5 ? args[4] : nil)
case "--copy-file" where args.count == 2:
    copyFile(args[1])
case "--sample" where args.count == 2:
    guard let picture = sample(), write(picture, to: args[1], type: .png) else { fail("cannot write the picture") }
    say(["file": args[1]])
case let file? where !file.hasPrefix("--"):
    guard let doc = PDFDocument(url: URL(fileURLWithPath: file)) else { fail("cannot open the PDF") }
    let total = doc.pageCount
    let first = max(1, args.count >= 2 ? Int(args[1]) ?? 1 : 1)
    let last = min(total, args.count >= 3 ? Int(args[2]) ?? total : total)
    readPdf(doc, first: first, last: last)
default:
    fail("usage: aced-ocr <file.pdf> [first] [last] | --prepare | --info <picture>... | --images <out.pdf> <picture>... | --render <file.pdf> <long-side> <folder> [first] [last] | --sample <out.png> | --clean <file.pdf> <out.pdf> | --can-share | --share <airdrop|messages|mail> <file> [subject] [text] | --copy-file <file>")
}
