import AppKit

@main
@MainActor
enum VerificationFixture {
    static func main() {
        let app = NSApplication.shared
        let delegate = FixtureDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}

@MainActor
final class FixtureDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let count = NSTextField(labelWithString: "Counter: 0")
    private var value = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 280), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Labora computer-use verification"
        let button = NSButton(title: "Increment counter", target: self, action: #selector(increment))
        button.setAccessibilityIdentifier("labora-ocu-increment")
        let stack = NSStackView(views: [count, button])
        stack.orientation = .vertical
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: window.contentView!.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor),
        ])
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func increment() {
        value += 1
        count.stringValue = "Counter: \(value)"
        if CommandLine.arguments.count == 2 {
            try? String(value).write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8)
        }
    }
}
