import AppKit
import Foundation

struct ClipboardImage: Encodable {
    let data: String
    let mimeType: String
    let name: String
}

struct ClipboardContents: Encodable {
    let text: String
    let files: [String]
    let image: ClipboardImage?
}

enum ClipboardFailure: LocalizedError {
    case usage
    case invalidText
    case imageTooLarge
    case writeFailed

    var errorDescription: String? {
        switch self {
        case .usage: return "Use clipboard-read or clipboard-copy-text."
        case .invalidText: return "Clipboard text must be UTF-8."
        case .imageTooLarge: return "The clipboard image exceeds 15 MB."
        case .writeFailed: return "macOS could not update the clipboard."
        }
    }
}

func readClipboard() throws -> ClipboardContents {
    let pasteboard = NSPasteboard.general
    let text = pasteboard.string(forType: .string) ?? ""
    let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    let files = urls.filter(\.isFileURL).map(\.path)

    if !files.isEmpty {
        return ClipboardContents(text: text, files: files, image: nil)
    }

    var png = pasteboard.data(forType: .png)

    if png == nil, let tiff = pasteboard.data(forType: .tiff), let bitmap = NSBitmapImageRep(data: tiff) {
        png = bitmap.representation(using: .png, properties: [:])
    }

    if let png {
        guard png.count <= 15_000_000 else { throw ClipboardFailure.imageTooLarge }
        return ClipboardContents(text: text, files: [], image: ClipboardImage(data: png.base64EncodedString(), mimeType: "image/png", name: "Pasted image.png"))
    }

    return ClipboardContents(text: text, files: [], image: nil)
}

do {
    switch CommandLine.arguments.dropFirst().first {
    case "clipboard-read":
        let data = try JSONEncoder().encode(readClipboard())
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    case "clipboard-copy-text":
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard let text = String(data: data, encoding: .utf8) else { throw ClipboardFailure.invalidText }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else { throw ClipboardFailure.writeFailed }
    default:
        throw ClipboardFailure.usage
    }
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
