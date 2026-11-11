import AppKit
import Carbon
import UserNotifications
import WebKit

// Forchetta.app: a window around a web view on the local daemon. The logic lives in the daemon and in the page
// (TypeScript). This shell only:
//   - starts the daemon when it is not running (through the CLI) and hands its token to the page;
//   - tells the page when the window cannot be seen, so that nothing animates or ticks in vain;
//   - gives the standard menus (without an Edit menu, copy and paste do not work in a web view);
//   - shows, outside the window, the sessions that wait for you: a badge on the icon in the Dock, and the
//     notifications the daemon asks for (src/daemon/attention.ts);
//   - puts an icon in the menu bar with the sessions, and a shortcut that shows or hides the window from
//     anywhere. Closing the window hides it: the app keeps running in the menu bar until Esci (⌘Q).
// It writes nothing outside the Forchetta folder: no window state, no web cache (non-persistent data store).
//
// Options for tests: --size 1240x800, --snapshot file.png, --eval "body of an async function" (prints what it
// returns), --minimize,
// --after seconds (when to evaluate, default 3), --snapshot-after seconds (default: right after the evaluation),
// --quit (quit after those), --quit-after seconds, --menu-dump (prints the menu of the icon at the time of the
// evaluation), --icon file.png (the icon of the menu bar, drawn black).

struct DaemonAuth: Equatable {
    let port: Int
    let token: String
}

final class Shell: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate, NSMenuDelegate {
    private let root: URL
    private let varDir: URL
    private let options: [String: String]
    private var window: NSWindow!
    private var webView: WKWebView!
    private var auth: DaemonAuth?
    private var askingAuth = false
    private var testsScheduled = false
    private var pageLoaded = false
    /** The sessions with a notification in the Notification Center. */
    private var notifiedIds = Set<String>()
    /** A click on a notification before the page was there: the session to show once it is. */
    private var pendingFocus: String?
    private var statusItem: NSStatusItem?
    /** What the page last said about the sessions, for the menu of the icon. */
    private var menuInfo: [String: Any] = [:]
    private var hotKeyRef: EventHotKeyRef?
    /** The shortcut as the menu shows it, when it could be registered. */
    private var hotKeyText: String?

    init(root: URL, varDir: URL, options: [String: String]) {
        self.root = root
        self.varDir = varDir
        self.options = options
    }

    // MARK: - Window

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Before launch ends, so that a click on a notification that opened the app reaches it.
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMenu()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "forchetta")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        // Opaque, with the color of the page behind it: a transparent web view makes the window server blend the
        // whole page at every frame of an animation (measured: much more CPU on an Intel Mac).
        webView.underPageBackgroundColor = NSColor(srgbRed: 0.122, green: 0.118, blue: 0.110, alpha: 1)

        let size = parseSize(options["size"]) ?? NSSize(width: 1240, height: 800)
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Forchetta"
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(srgbRed: 0.122, green: 0.118, blue: 0.110, alpha: 1)
        window.isRestorable = false
        window.minSize = NSSize(width: 420, height: 320)
        window.contentView = webView
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(visibilityChanged), name: NSWindow.didChangeOcclusionStateNotification, object: window)
        center.addObserver(self, selector: #selector(visibilityChanged), name: NSWindow.didMiniaturizeNotification, object: window)
        center.addObserver(self, selector: #selector(visibilityChanged), name: NSWindow.didDeminiaturizeNotification, object: window)
        center.addObserver(self, selector: #selector(visibilityChanged), name: NSApplication.didHideNotification, object: nil)
        center.addObserver(self, selector: #selector(visibilityChanged), name: NSApplication.didUnhideNotification, object: nil)
        // "Riduci movimento" switched while the window is open: the media query of the web view may not follow it.
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(reducedMotionChanged),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil
        )

        setUpStatusItem()
        // Files of the Forchetta folder are read off the main thread: on the Desktop, macOS may first ask whether
        // the app may open them, and the window must not freeze meanwhile.
        DispatchQueue.global(qos: .userInitiated).async {
            let setting = self.readHotKeySetting()
            DispatchQueue.main.async { self.registerHotKey(setting) }
        }
        loadPage()
    }

    /// Closing the window hides it: notifications, badge and the icon in the menu bar go on. Esci (⌘Q) ends the app.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        visibilityChanged()
        return false
    }

    /// A click on the icon in the Dock brings the window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    @objc func showWindow() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        visibilityChanged()
    }

    /// The shortcut: the window comes to the front, or goes away if it is already there.
    func toggleWindow() {
        if NSApp.isActive && window.isVisible && !window.isMiniaturized {
            NSApp.hide(nil)
        } else {
            showWindow()
        }
    }

    private func loadPage() {
        DispatchQueue.global(qos: .userInitiated).async {
            let found = self.ensureDaemon()
            DispatchQueue.main.async {
                guard let found = found else {
                    self.showProblem()
                    return
                }
                self.auth = found
                self.installAuth(found)
                self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(found.port)/")!))
            }
        }
    }

    /// The token reaches the page before any of its scripts runs. Tokens are hex, safe inside a JS string.
    private func installAuth(_ auth: DaemonAuth) {
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let source = "window.__FORCHETTA__ = { token: '\(auth.token)', port: \(auth.port), reducedMotion: \(reduce) };"
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private func showProblem() {
        let log = varDir.appendingPathComponent("daemon.log").path
        let html = """
        <html><body style="background:#1f1e1c;color:#bdb8ae;font:13px -apple-system;padding:48px">
        <p>The Forchetta daemon did not start.</p><p style="font-family:ui-monospace">\(log)</p></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "needAuth":
            refreshAuth()
        case "attention":
            let waiting = (body["waiting"] as? [String]) ?? []
            updateAttention(count: (body["count"] as? Int) ?? waiting.count, waiting: waiting)
        case "notify":
            guard let id = body["id"] as? String, let title = body["title"] as? String, let text = body["body"] as? String else { return }
            notify(id: id, kind: (body["kind"] as? String) ?? "waiting", title: title, body: text)
        case "chooseFolder":
            chooseFolder(startingAt: body["folder"] as? String)
        case "menu":
            menuInfo = body
            updateStatusTitle()
        default:
            break
        }
    }

    // MARK: - Icon in the menu bar

    private func setUpStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = Shell.forkImage()
        item.button?.imagePosition = .imageLeft
        item.button?.toolTip = "Forchetta"
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        statusItem = item
    }

    /// A fork, drawn as a template image: macOS colors it as the other icons of the menu bar.
    static func forkImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            NSColor.black.setFill()
            for x in [5.2, 7.7, 10.2, 12.7] {
                NSBezierPath(roundedRect: NSRect(x: x - 0.1, y: 10.5, width: 1.3, height: 6), xRadius: 0.65, yRadius: 0.65).fill()
            }
            NSBezierPath(roundedRect: NSRect(x: 5.1, y: 9, width: 8.8, height: 2.6), xRadius: 1.3, yRadius: 1.3).fill()
            let neck = NSBezierPath()
            neck.move(to: NSPoint(x: 7.4, y: 9.4))
            neck.line(to: NSPoint(x: 11.6, y: 9.4))
            neck.line(to: NSPoint(x: 10.1, y: 6.6))
            neck.line(to: NSPoint(x: 8.9, y: 6.6))
            neck.close()
            neck.fill()
            NSBezierPath(roundedRect: NSRect(x: 8.6, y: 0.8, width: 1.8, height: 6.4), xRadius: 0.9, yRadius: 0.9).fill()
            return true
        }
        image.isTemplate = true
        return image
    }

    /// Next to the icon: how many sessions wait for you, as on the Dock.
    private func updateStatusTitle() {
        let waiting = (menuInfo["waiting"] as? Int) ?? 0
        statusItem?.button?.title = waiting > 0 ? " \(waiting)" : ""
    }

    /// The menu is made when it opens: the time left of each cache is the one of that moment.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let sessions = (menuInfo["sessions"] as? [[String: Any]]) ?? []
        let waiting = (menuInfo["waiting"] as? Int) ?? 0
        let head = waiting == 0 ? "No session waits for you" : waiting == 1 ? "1 session waits for you" : "\(waiting) sessions wait for you"
        menu.addItem(disabledItem(head))
        if let today = menuInfo["today"] as? String { menu.addItem(disabledItem(today)) }
        menu.addItem(.separator())
        if sessions.isEmpty { menu.addItem(disabledItem("No session running")) }
        let now = Date().timeIntervalSince1970 * 1000
        for session in sessions {
            guard let id = session["id"] as? String, let name = session["name"] as? String else { continue }
            var parts = [(session["state"] as? String) ?? ""]
            if let detail = session["detail"] as? String { parts.append(detail) }
            if session["waiting"] as? Bool != true, let expires = session["cacheExpiresAt"] as? Double {
                let left = Int((expires - now) / 60000)
                parts.append(left > 0 ? "cache \(left) min" : "cache expired")
            }
            if let cost = session["cost"] as? String { parts.append(cost) }
            let line = parts.filter { !$0.isEmpty }.joined(separator: " · ")
            let text = "\(session["waiting"] as? Bool == true ? "● " : "")\(name) — \(line)"
            let item = NSMenuItem(title: text.count > 90 ? String(text.prefix(89)) + "…" : text, action: #selector(openSession(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = id
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let show = NSMenuItem(title: hotKeyText.map { "Show Forchetta (\($0))" } ?? "Show Forchetta", action: #selector(showWindow), keyEquivalent: "")
        show.target = self
        menu.addItem(show)
        let new = NSMenuItem(title: "New session…", action: #selector(newSession), keyEquivalent: "")
        new.target = self
        menu.addItem(new)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Forchetta", action: #selector(NSApplication.terminate(_:)), keyEquivalent: ""))
    }

    private func disabledItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func openSession(_ sender: NSMenuItem) {
        showWindow()
        if let id = sender.representedObject as? String { focus(id) }
    }

    @objc private func newSession() {
        showWindow()
        webView.evaluateJavaScript("window.forchettaNewSession && window.forchettaNewSession()")
    }

    // MARK: - Shortcut from anywhere

    /// Carbon's hot keys need no Accessibility permission. The shortcut comes from var/config.json ("hotkey").
    private func registerHotKey(_ wanted: String) {
        guard !wanted.isEmpty, let parsed = Shell.parseHotKey(wanted) else {
            if !wanted.isEmpty { print("scorciatoia non valida: \(wanted)") }
            return
        }
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let handler: EventHandlerUPP = { _, _, userData in
            guard let userData = userData else { return noErr }
            let shell = Unmanaged<Shell>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { shell.toggleWindow() }
            return noErr
        }
        InstallEventHandler(GetApplicationEventTarget(), handler, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), nil)
        let id = EventHotKeyID(signature: OSType(0x464B_5452), id: 1)
        let status = RegisterEventHotKey(parsed.keyCode, parsed.modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef)
        if status == noErr {
            hotKeyText = parsed.text
            print("scorciatoia: \(parsed.text)")
        } else {
            print("scorciatoia \(parsed.text) non disponibile (\(status)): forse la usa un'altra app")
        }
    }

    private func readHotKeySetting() -> String {
        let config = varDir.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: config),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return "ctrl+alt+f" }
        return (json["hotkey"] as? String) ?? "ctrl+alt+f"
    }

    /// "ctrl+alt+f" → the key code, the Carbon modifiers and "⌃⌥F". Letters, digits and space.
    static func parseHotKey(_ text: String) -> (keyCode: UInt32, modifiers: UInt32, text: String)? {
        let keys: [String: Int] = [
            "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
            "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
            "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
            "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
            "y": kVK_ANSI_Y, "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
            "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
            "space": kVK_Space,
        ]
        var modifiers = 0
        var symbols = ""
        var key: Int?
        var keyName = ""
        for part in text.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            switch part {
            case "ctrl", "control": modifiers |= controlKey; symbols += "⌃"
            case "alt", "option", "opt": modifiers |= optionKey; symbols += "⌥"
            case "shift": modifiers |= shiftKey; symbols += "⇧"
            case "cmd", "command": modifiers |= cmdKey; symbols += "⌘"
            default:
                guard key == nil, let code = keys[part] else { return nil }
                key = code
                keyName = part == "space" ? "Space" : part.uppercased()
            }
        }
        // A shortcut with no modifier would take a key away from every app.
        guard let code = key, modifiers != 0 else { return nil }
        return (UInt32(code), UInt32(modifiers), symbols + keyName)
    }

    // MARK: - Folder of a new session

    /// The panel of macOS for a folder; the choice goes back to the page, which starts nothing by itself.
    private func chooseFolder(startingAt folder: String?) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.message = "The folder of the new session"
        if let folder = folder, !folder.isEmpty {
            let expanded = (folder as NSString).expandingTildeInPath
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: expanded, isDirectory: &isDirectory), isDirectory.boolValue {
                panel.directoryURL = URL(fileURLWithPath: expanded)
            }
        }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let path = panel.url?.path,
                  let data = try? JSONSerialization.data(withJSONObject: [path]),
                  let array = String(data: data, encoding: .utf8) else { return }
            // A JSON array of one string: a safe JavaScript literal for any path.
            self.webView.evaluateJavaScript("window.forchettaFolder && window.forchettaFolder(\(array)[0])")
        }
    }

    // MARK: - Badge and notifications

    /// The badge counts the sessions that wait; the notifications of those that stopped waiting go away.
    private func updateAttention(count: Int, waiting: [String]) {
        NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
        print("badge: \(count)")
        let gone = notifiedIds.subtracting(waiting)
        guard !gone.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: Array(gone))
        center.removePendingNotificationRequests(withIdentifiers: Array(gone))
        notifiedIds.subtract(gone)
    }

    /// macOS asks you once whether Forchetta may notify; the answer is kept in System Settings, Notifications.
    /// A wait has one notification per session, taken away when the session stops waiting. A stall or an error has
    /// its own, which stays in the Notification Center until you clear it.
    private func notify(id: String, kind: String, title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            guard granted else {
                print("notifica non permessa\(error.map { ": \($0)" } ?? "")")
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.userInfo = ["agentId": id]
            // One per session: the notification of a new wait replaces that of the previous one.
            let identifier = kind == "waiting" ? id : "\(id):\(kind)"
            center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)) { error in
                if let error = error {
                    print("notifica non riuscita: \(error)")
                    return
                }
                print("notifica: \(title) · \(body)")
                if kind == "waiting" { DispatchQueue.main.async { self.notifiedIds.insert(id) } }
            }
        }
    }

    /// With the app in front and its window on screen, the box already says it: no banner.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async {
            let onScreen = self.window != nil && self.window.isVisible && !self.window.isMiniaturized
            completionHandler(onScreen ? [] : [.banner, .list, .sound])
        }
    }

    /// A click on a notification: the window comes back, on that session.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["agentId"] as? String
        DispatchQueue.main.async {
            if let window = self.window {
                if window.isMiniaturized { window.deminiaturize(nil) }
                window.makeKeyAndOrderFront(nil)
            }
            NSApp.activate(ignoringOtherApps: true)
            if let id = id { self.focus(id) }
            completionHandler()
        }
    }

    private func focus(_ id: String) {
        // Agent ids are UUIDs: safe inside a JS string.
        guard !id.isEmpty, id.allSatisfy({ $0.isHexDigit || $0 == "-" }) else { return }
        if pageLoaded {
            webView.evaluateJavaScript("window.forchettaFocus && window.forchettaFocus('\(id)')")
        } else {
            pendingFocus = id
        }
    }

    /// The page could not connect: a daemon that restarted has a new token, a stopped one is started again.
    private func refreshAuth() {
        if askingAuth { return }
        askingAuth = true
        DispatchQueue.global(qos: .userInitiated).async {
            let found = self.ensureDaemon()
            DispatchQueue.main.async {
                self.askingAuth = false
                guard let found = found else { return }
                let portChanged = self.auth?.port != found.port
                self.auth = found
                self.installAuth(found)
                if portChanged {
                    self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(found.port)/")!))
                } else {
                    self.webView.evaluateJavaScript("window.forchettaAuth && window.forchettaAuth({ token: '\(found.token)', port: \(found.port) })")
                }
            }
        }
    }

    // MARK: - Visibility

    @objc private func visibilityChanged() {
        guard webView != nil else { return }
        let visible = window.occlusionState.contains(.visible) && !window.isMiniaturized && !NSApp.isHidden
        webView.evaluateJavaScript("window.forchettaVisibility && window.forchettaVisibility(\(visible))")
    }

    @objc private func reducedMotionChanged() {
        guard webView != nil else { return }
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        webView.evaluateJavaScript("window.forchettaReducedMotion && window.forchettaReducedMotion(\(reduce))")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        if let id = pendingFocus {
            pendingFocus = nil
            // The page connects first, then knows the session.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.focus(id) }
        }
        visibilityChanged()
        reducedMotionChanged()
        writeProcessInfo()
        scheduleTests()
    }

    // MARK: - Daemon

    private func readAuth() -> DaemonAuth? {
        let file = varDir.appendingPathComponent("daemon.json")
        guard let data = try? Data(contentsOf: file),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let port = json["port"] as? Int,
              let token = json["token"] as? String,
              token.allSatisfy({ $0.isHexDigit })
        else { return nil }
        return DaemonAuth(port: port, token: token)
    }

    private func healthy(_ auth: DaemonAuth) -> Bool {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(auth.port)/api/health")!, timeoutInterval: 1.5)
        request.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
        let done = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            ok = (response as? HTTPURLResponse)?.statusCode == 200
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 2)
        return ok
    }

    /// The daemon that answers, starting it with `forchetta daemon start` when needed. Not on the main thread.
    private func ensureDaemon() -> DaemonAuth? {
        if let auth = readAuth(), healthy(auth) { return auth }
        runCLI(["daemon", "start"])
        if let auth = readAuth(), healthy(auth) { return auth }
        return nil
    }

    private func nodePath() -> String {
        let config = varDir.appendingPathComponent("config.json")
        if let data = try? Data(contentsOf: config),
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let paths = json["paths"] as? [String: Any],
           let node = paths["node"] as? String,
           FileManager.default.isExecutableFile(atPath: node) {
            return node
        }
        for candidate in ["/usr/local/bin/node", "/opt/homebrew/bin/node"] where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return "/usr/local/bin/node"
    }

    private func runCLI(_ arguments: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath())
        process.arguments = [root.appendingPathComponent("dist/cli.js").path] + arguments
        var environment = ProcessInfo.processInfo.environment
        // An app opened from the Finder has a short PATH: the daemon uses the full paths of var/config.json.
        environment["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            NSLog("forchetta: avvio del daemon non riuscito: \(error)")
        }
    }

    /// For the measurements: the pid of this app and of its web content process, in var/app.json. Written off the
    /// main thread, as every file of the Forchetta folder.
    private func writeProcessInfo() {
        var info: [String: Any] = ["appPid": ProcessInfo.processInfo.processIdentifier, "windowNumber": window.windowNumber]
        let selector = NSSelectorFromString("_webProcessIdentifier")
        if webView.responds(to: selector), let pid = webView.value(forKey: "_webProcessIdentifier") as? Int32 {
            info["webContentPid"] = pid
        }
        let file = varDir.appendingPathComponent("app.json")
        DispatchQueue.global(qos: .utility).async {
            if let data = try? JSONSerialization.data(withJSONObject: info) { try? data.write(to: file) }
        }
    }

    // MARK: - Test options

    private func scheduleTests() {
        if testsScheduled { return }
        if let seconds = options["quit-after"].flatMap(Double.init) {
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { NSApp.terminate(nil) }
        }
        if let path = options["icon"], let tiff = Shell.forkImage().tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
            print("icona: \(path)")
        }
        let wanted = options["snapshot"] != nil || options["eval"] != nil || options["minimize"] != nil || options["menu-dump"] != nil
        if !wanted { return }
        testsScheduled = true
        if options["minimize"] != nil { window.miniaturize(nil) }
        let evalDelay = Double(options["after"] ?? "3") ?? 3
        // The snapshot comes after the evaluation, or at its own time with --snapshot-after.
        let snapshotDelay = options["snapshot-after"].flatMap(Double.init) ?? evalDelay + 0.05
        if let script = options["eval"] {
            pendingTests += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + evalDelay) {
                // The script is the body of an async function: it can await, and returns its result.
                self.webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
                    switch result {
                    case .success(let value):
                        print("eval: \(value)")
                    case .failure(let error):
                        print("eval errore: \(error)")
                    }
                    self.testDone()
                }
            }
        }
        if options["menu-dump"] != nil {
            pendingTests += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + evalDelay + 0.3) {
                let menu = NSMenu()
                self.menuNeedsUpdate(menu)
                print("titolo icona: [\(self.statusItem?.button?.title ?? "")]")
                for item in menu.items { print("menu: \(item.isSeparatorItem ? "———" : item.title)\(item.isEnabled || item.isSeparatorItem ? "" : " (disattivata)")") }
                self.testDone()
            }
        }
        if let path = options["snapshot"] {
            pendingTests += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + snapshotDelay) {
                self.webView.takeSnapshot(with: nil) { image, error in
                    if let image = image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                       let png = bitmap.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: path))
                        print("snapshot: \(path)")
                    } else {
                        print("snapshot non riuscito: \(String(describing: error))")
                    }
                    self.testDone()
                }
            }
        }
    }

    private var pendingTests = 0

    private func testDone() {
        pendingTests -= 1
        if pendingTests == 0 && options["quit"] != nil { NSApp.terminate(nil) }
    }

    private func parseSize(_ text: String?) -> NSSize? {
        guard let parts = text?.split(separator: "x"), parts.count == 2,
              let width = Double(parts[0]), let height = Double(parts[1]) else { return nil }
        return NSSize(width: width, height: height)
    }

    // MARK: - Menus

    private func makeMenu() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Forchetta", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Forchetta", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Forchetta", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r").target = self
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        return main
    }

    @objc private func reloadPage() {
        if auth == nil { loadPage() } else { webView.reload() }
    }
}

// MARK: - Start

// One line at a time also when stdout is a file: the tests read it while the app runs.
setvbuf(stdout, nil, _IOLBF, 0)

var options: [String: String] = [:]
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let argument = arguments.next() {
    guard argument.hasPrefix("--") else { continue }
    let key = String(argument.dropFirst(2))
    if ["minimize", "quit", "menu-dump"].contains(key) {
        options[key] = "1"
    } else if let value = arguments.next() {
        options[key] = value
    }
}

let info = Bundle.main.infoDictionary
let root = (info?["ForchettaRoot"] as? String).map { URL(fileURLWithPath: $0) }
    ?? Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
/// The private folder of Forchetta, by the rule of src/shared/paths.ts: FORCHETTA_VAR; var/ in a git checkout;
/// otherwise ~/Library/Application Support/Forchetta, for an installed copy.
let varDir: URL = {
    if let value = ProcessInfo.processInfo.environment["FORCHETTA_VAR"], !value.isEmpty { return URL(fileURLWithPath: value) }
    if FileManager.default.fileExists(atPath: root.appendingPathComponent(".git").path) { return root.appendingPathComponent("var") }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Forchetta")
}()

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let shell = Shell(root: root, varDir: varDir, options: options)
app.delegate = shell
app.run()
