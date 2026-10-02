import AppKit
import Foundation

let pasteboard = NSPasteboard.general
var original: [NSPasteboardItem] = []

for source in pasteboard.pasteboardItems ?? [] {
    let copy = NSPasteboardItem()
    for type in source.types {
        if let data = source.data(forType: type) { copy.setData(data, forType: type) }
    }
    original.append(copy)
}

let arguments = Array(CommandLine.arguments.dropFirst())

guard let kind = arguments.first, arguments.count >= 2 else {
    FileHandle.standardError.write(Data("Specify files or image and fixture paths.\n".utf8))
    exit(1)
}

var items: [NSPasteboardWriting] = []

if kind == "files" {
    items = arguments.dropFirst().map { NSURL(fileURLWithPath: $0) }
} else if kind == "image" {
    do {
        let data = try Data(contentsOf: URL(fileURLWithPath: arguments[1]))
        let item = NSPasteboardItem()
        item.setData(data, forType: .png)
        items = [item]
    } catch {
        FileHandle.standardError.write(Data("Could not load the fixture image.\n".utf8))
        exit(1)
    }
} else {
    FileHandle.standardError.write(Data("Unknown clipboard fixture kind.\n".utf8))
    exit(1)
}

pasteboard.clearContents()

guard pasteboard.writeObjects(items) else {
    pasteboard.clearContents()
    pasteboard.writeObjects(original)
    FileHandle.standardError.write(Data("Could not set the clipboard fixture.\n".utf8))
    exit(1)
}

let fixtureChangeCount = pasteboard.changeCount
FileHandle.standardOutput.write(Data("ready\n".utf8))
_ = readLine()

if pasteboard.changeCount == fixtureChangeCount {
    pasteboard.clearContents()
    pasteboard.writeObjects(original)
    let restored = pasteboard.pasteboardItems ?? []
    let matches = restored.count == original.count && zip(restored, original).allSatisfy { actual, expected in
        Set(actual.types) == Set(expected.types) && expected.types.allSatisfy { actual.data(forType: $0) == expected.data(forType: $0) }
    }
    guard matches else {
        FileHandle.standardError.write(Data("Clipboard restoration did not match its original representations.\n".utf8))
        exit(1)
    }
    FileHandle.standardOutput.write(Data("restored\n".utf8))
} else {
    FileHandle.standardOutput.write(Data("preserved-newer-clipboard\n".utf8))
}
