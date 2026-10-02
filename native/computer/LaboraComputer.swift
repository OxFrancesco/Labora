import AppKit
import ApplicationServices
import ScreenCaptureKit
import Darwin

struct CompanionFailure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

@MainActor final class Companion: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem?
    private var held = Set<Int>()
    private let socketPath: String
    private let nonce: String
    private let parentPID: pid_t
    private var server: Int32 = -1
    init(socketPath: String, nonce: String, parentPID: pid_t) { self.socketPath = socketPath; self.nonce = nonce; self.parentPID = parentPID }

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item?.button?.title = "Labora"
        let menu = NSMenu()
        menu.addItem(withTitle: "Allow Screen Recording…", action: #selector(requestCapture), keyEquivalent: "")
        menu.addItem(withTitle: "Allow Accessibility…", action: #selector(requestInput), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit computer companion", action: #selector(quit), keyEquivalent: "")
        for menuItem in menu.items { menuItem.target = self }
        item?.menu = menu
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if kill(self.parentPID, 0) != 0 && errno == ESRCH { self.quit() }
            }
        }
        do { try listen() } catch { fputs("Labora Computer: \(error.localizedDescription)\n", stderr); NSApp.terminate(nil) }
    }
    @objc private func requestCapture() { CGRequestScreenCaptureAccess() }
    @objc private func requestInput() { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
    @objc private func quit() { release(); NSApp.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) {
        release()
        if server >= 0 { Darwin.close(server) }
        unlink(socketPath)
    }

    private func listen() throws {
        server = socket(AF_UNIX, SOCK_STREAM, 0)
        guard server >= 0 else { throw CompanionFailure("Could not create private socket") }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8CString)
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw CompanionFailure("Private socket path is too long") }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            for (index, byte) in pathBytes.enumerated() { buffer[index] = UInt8(bitPattern: byte) }
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, chmod(socketPath, 0o600) == 0, Darwin.listen(server, 8) == 0 else { throw CompanionFailure("Could not bind private socket") }
        let listener = server
        let expectedNonce = nonce
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while true {
                let client = Darwin.accept(listener, nil, nil)
                if client < 0 { break }
                var uid: uid_t = 0, gid: gid_t = 0
                guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else { Darwin.close(client); continue }
                var timeout = timeval(tv_sec: 15, tv_usec: 0)
                setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
                setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
                var bytes = Data()
                var chunk = [UInt8](repeating: 0, count: 8192)
                while bytes.count < 131072 {
                    let count = Darwin.read(client, &chunk, chunk.count)
                    if count <= 0 { break }
                    bytes.append(contentsOf: chunk.prefix(count))
                    if bytes.contains(10) { break }
                }
                guard bytes.count < 131072, let newline = bytes.firstIndex(of: 10),
                      let object = try? JSONSerialization.jsonObject(with: bytes.prefix(upTo: newline)) as? [String: Any],
                      object["nonce"] as? String == expectedNonce, let method = object["method"] as? String else {
                    Darwin.close(client); continue
                }
                let params = object["params"] as? [String: Any] ?? [:]
                Task { @MainActor [weak self] in
                    do {
                        guard let self else { throw CompanionFailure("Companion stopped") }
                        let result = try await self.handle(method, params)
                        Self.reply(client, ["ok": true, "result": result])
                        if method == "shutdown" { self.quit() }
                    } catch { Self.reply(client, ["ok": false, "error": error.localizedDescription]) }
                }
            }
        }
    }
    private static func reply(_ client: Int32, _ value: [String: Any]) {
        defer { Darwin.close(client) }
        guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(10)
        data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var sent = 0
            while sent < data.count {
                let count = Darwin.write(client, base.advanced(by: sent), data.count - sent)
                if count <= 0 { break }
                sent += count
            }
        }
    }
    private func displays() throws -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success else { throw CompanionFailure("Cannot enumerate displays") }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &displays, &count) == .success else { throw CompanionFailure("Cannot enumerate displays") }
        return displays
    }
    private func handle(_ method: String, _ params: [String: Any]) async throws -> Any {
        switch method {
        case "permissions.status":
            let capture = CGPreflightScreenCaptureAccess(), input = AXIsProcessTrusted() && CGPreflightPostEventAccess()
            let screens: [[String: Any]] = try displays().map { id in
                let bounds = CGDisplayBounds(id)
                return ["id": String(id), "name": "Display \(id)", "x": bounds.minX, "y": bounds.minY,
                        "width": bounds.width, "height": bounds.height, "pixelWidth": CGDisplayPixelsWide(id),
                        "pixelHeight": CGDisplayPixelsHigh(id), "scale": Double(CGDisplayPixelsWide(id)) / bounds.width]
            }
            var capabilities: [String] = []
            if capture { capabilities.append("capture") }
            if input { capabilities.append("input") }
            return ["platform": "macos", "capabilities": capabilities, "displays": screens,
                    "permissions": ["screenCapture": capture ? "granted" : "denied", "accessibility": input ? "granted" : "denied"],
                    "diagnostics": ["Permission owner: \(Bundle.main.bundleIdentifier ?? "unknown")", "Executable: \(Bundle.main.executablePath ?? "unknown")", "Event posting: \(CGPreflightPostEventAccess() ? "granted" : "denied")"]]
        case "capture":
            guard CGPreflightScreenCaptureAccess() else { throw CompanionFailure("Grant Screen Recording to Labora Computer in System Settings") }
            guard let raw = params["displayId"] as? String, let id = UInt32(raw) else { throw CompanionFailure("Invalid display ID") }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == id }) else { throw CompanionFailure("Display is no longer available") }
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.width = CGDisplayPixelsWide(id); config.height = CGDisplayPixelsHigh(id)
            config.showsCursor = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw CompanionFailure("Cannot encode screenshot") }
            return ["png": png.base64EncodedString()]
        case "action":
            guard AXIsProcessTrusted() else { throw CompanionFailure("Grant Accessibility to Labora Computer in System Settings") }
            try input(params); return ["executed": 1]
        case "release": release(); return [:]
        case "shutdown": release(); return [:]
        default: throw CompanionFailure("Unknown native operation")
        }
    }
    private func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, count: Int = 1) {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(count)); event.post(tap: .cghidEventTap)
    }
    private func release() {
        let point = CGEvent(source: nil)?.location ?? .zero
        for raw in held {
            let button: CGMouseButton = raw == 1 ? .right : raw == 2 ? .center : .left
            mouse(button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp, point, button)
        }
        held.removeAll()
    }
    private func input(_ params: [String: Any]) throws {
        guard let type = params["type"] as? String else { throw CompanionFailure("Missing input type") }
        let point = CGPoint(x: params["x"] as? Double ?? 0, y: params["y"] as? Double ?? 0)
        let button: CGMouseButton = params["button"] as? String == "right" ? .right : params["button"] as? String == "middle" ? .center : .left
        let down: CGEventType = button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown
        let up: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
        switch type {
        case "move": mouse(held.contains(0) ? .leftMouseDragged : held.contains(1) ? .rightMouseDragged : held.contains(2) ? .otherMouseDragged : .mouseMoved, point, held.contains(1) ? .right : held.contains(2) ? .center : .left)
        case "pointer_down": mouse(down, point, button); held.insert(Int(button.rawValue))
        case "pointer_up": mouse(up, point, button); held.remove(Int(button.rawValue))
        case "click":
            let count = min(2, max(1, params["count"] as? Int ?? 1))
            for index in 1...count { mouse(down, point, button, count: index); mouse(up, point, button, count: index) }
        case "scroll":
            let dy = min(1000, max(-1000, params["deltaY"] as? Int ?? 0)), dx = min(1000, max(-1000, params["deltaX"] as? Int ?? 0))
            let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0)
            event?.location = point; event?.post(tap: .cghidEventTap)
        case "type":
            guard let text = params["text"] as? String, text.utf8.count <= 32768 else { throw CompanionFailure("Invalid text") }
            for character in text {
                let units = Array(String(character).utf16)
                for down in [true, false] {
                    let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                    units.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
                    event?.post(tap: .cghidEventTap)
                }
            }
        case "key":
            guard let chord = params["key"] as? String else { throw CompanionFailure("Missing key") }
            try key(chord)
        default: throw CompanionFailure("Unsupported input type")
        }
    }
    private func key(_ chord: String) throws {
        let parts = chord.lowercased().split(separator: "+").map(String.init)
        guard let main = parts.last else { throw CompanionFailure("Missing key") }
        let keys: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"enter":36,"return":36,"l":37,"j":38,"k":40,"n":45,"m":46,"tab":48,"space":49,"backspace":51,"escape":53,"delete":117,"home":115,"end":119,"pageup":116,"pagedown":121,"left":123,"right":124,"down":125,"up":126,"f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111]
        guard let code = keys[main] else { throw CompanionFailure("Unsupported key: \(main)") }
        var flags: CGEventFlags = []
        for modifier in parts.dropLast() {
            switch modifier {
            case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
            case "ctrl", "control": flags.insert(.maskControl)
            case "alt", "option": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            default: throw CompanionFailure("Unsupported modifier")
            }
        }
        for down in [true, false] { let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down); event?.flags = flags; event?.post(tap: .cghidEventTap) }
    }
}

@main enum Main {
    @MainActor static func main() {
        let args = CommandLine.arguments
        func value(_ flag: String) -> String? { guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }; return args[index + 1] }
        guard let socketPath = value("--socket"), let noncePath = value("--nonce-file"), let parent = value("--parent-pid"), let parentPID = Int32(parent), parentPID > 1, let nonce = try? String(contentsOfFile: noncePath, encoding: .utf8), nonce.count >= 40 else {
            fputs("Launch this helper through the Labora companion.\n", stderr); exit(1)
        }
        signal(SIGPIPE, SIG_IGN)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let companion = Companion(socketPath: socketPath, nonce: nonce, parentPID: parentPID)
        app.delegate = companion
        app.run()
    }
}
