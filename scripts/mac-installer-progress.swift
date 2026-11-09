import AppKit

let statusFile = CommandLine.arguments[1]
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 440, height: 125),
    styleMask: [.titled],
    backing: .buffered,
    defer: false
)
window.title = "AfterShelf Web Setup"
window.center()

let heading = NSTextField(labelWithString: "Installing AfterShelf")
heading.font = .systemFont(ofSize: 17, weight: .semibold)
let progress = NSProgressIndicator()
progress.style = .bar
progress.minValue = 0
progress.maxValue = 100
let detail = NSTextField(labelWithString: "")
detail.textColor = .secondaryLabelColor

let stack = NSStackView(views: [heading, progress, detail])
stack.orientation = .vertical
stack.alignment = .leading
stack.spacing = 10
stack.translatesAutoresizingMaskIntoConstraints = false
let content = window.contentView!
content.addSubview(stack)
NSLayoutConstraint.activate([
    stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
    stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
    stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
    progress.widthAnchor.constraint(equalTo: stack.widthAnchor)
])

func refreshProgress() {
    guard let state = try? String(contentsOfFile: statusFile, encoding: .utf8) else {
        app.terminate(nil)
        return
    }
    let fields = state.trimmingCharacters(in: .newlines).components(separatedBy: "\t")
    let received = fields.count == 3 ? Double(fields[1]) ?? 0 : 0
    let total = fields.count == 3 ? Double(fields[2]) ?? 0 : 0
    let determinate = total > 0
    if determinate {
        progress.stopAnimation(nil)
        progress.isIndeterminate = false
        let percent = min(100, 100 * received / total)
        progress.doubleValue = percent
        detail.stringValue = "\(fields[0]) \(Int(percent))%"
    } else {
        progress.isIndeterminate = true
        progress.startAnimation(nil)
        detail.stringValue = received > 0
            ? "\(fields[0]) \(ByteCountFormatter.string(fromByteCount: Int64(received), countStyle: .file)) downloaded"
            : fields[0]
    }
}

window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
refreshProgress()
let timer = Timer(timeInterval: 0.25, repeats: true) { _ in refreshProgress() }
RunLoop.main.add(timer, forMode: .common)
app.run()
