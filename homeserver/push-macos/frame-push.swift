// frame-push: send a curated snapshot of macOS Calendar events to the frame's home server.
//
// Reads the calendars you chose (e.g. a Google Workspace account added under System Settings →
// Internet Accounts) through EventKit, and PUTs titles and times only to
//   <server>/api/push/<pushId>   with   Authorization: Bearer <token from the login Keychain>.
// No attendees, notes, locations, URLs or conference data are read into the payload.
//
//   frame-push                    push once (what the LaunchAgent runs every 5 minutes)
//   frame-push --dry-run          print the JSON that would be sent, send nothing
//   frame-push --list-calendars   print calendar titles, accounts and identifiers
//   frame-push --request-access   ask for Calendar access (run once from Terminal)
//
// Config: ~/Library/Application Support/frame-push/config.json (see config.example.json).
// Needs macOS 14 or later (EventKit full access). Network failures (laptop away from home) print one line and exit 0, so launchd just retries.

import EventKit
import Foundation
import Security

let keychainService = "frame-push"
let configURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/frame-push/config.json")

struct Config: Decodable {
    let server: String           // e.g. "http://<nas-ip>:8088"
    let pushId: String           // the id in PUSH_CALENDARS
    let calendars: [String]      // calendar identifiers (preferred) or titles
    let daysAhead: Int?          // default 14
    let daysBack: Int?           // default 1
    let busyOnly: Bool?          // send "Busy" instead of titles
    let exclude: [String]?       // regexes; matching titles are skipped (case-insensitive)
    let skipDeclined: Bool?      // default true
}

func log(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write("\(stamp) frame-push: \(message)\n".data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
    log(message)
    exit(1)
}

// MARK: - Calendar access

func requestAccess(_ store: EKEventStore) -> Bool {
    let done = DispatchSemaphore(value: 0)
    var granted = false
    store.requestFullAccessToEvents { ok, error in
        granted = ok
        if let error = error { log("Calendar access error: \(error.localizedDescription)") }
        done.signal()
    }
    done.wait()
    return granted
}

func hasAccess() -> Bool {
    return EKEventStore.authorizationStatus(for: .event) == .fullAccess
}

// MARK: - Keychain

func token(for account: String) -> String? {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data, let value = String(data: data, encoding: .utf8) else { return nil }
    return value.trimmingCharacters(in: .whitespacesAndNewlines)
}

// MARK: - Snapshot

func loadConfig() -> Config {
    guard let data = try? Data(contentsOf: configURL) else { fail("No config at \(configURL.path); see README") }
    do { return try JSONDecoder().decode(Config.self, from: data) } catch { fail("Config is not valid: \(error)") }
}

func ymd(_ date: Date, _ cal: Calendar) -> String {
    let c = cal.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
}

func snapshot(_ store: EKEventStore, _ config: Config) -> [[String: Any]] {
    let wanted = Set(config.calendars)
    let calendars = store.calendars(for: .event).filter {
        wanted.contains($0.calendarIdentifier) || wanted.contains($0.title)
    }
    if calendars.isEmpty { fail("None of the configured calendars exist; run --list-calendars") }

    let cal = Calendar.current
    let today = cal.startOfDay(for: Date())
    let from = cal.date(byAdding: .day, value: -max(0, config.daysBack ?? 1), to: today)!
    let to = cal.date(byAdding: .day, value: min(60, max(1, config.daysAhead ?? 14)), to: today)!
    let excludes = (config.exclude ?? []).compactMap { try? NSRegularExpression(pattern: $0, options: [.caseInsensitive]) }

    var out: [[String: Any]] = []
    for event in store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: calendars)) {
        if event.status == .canceled { continue }
        if config.skipDeclined ?? true,
           let me = event.attendees?.first(where: { $0.isCurrentUser }), me.participantStatus == .declined { continue }
        let rawTitle = event.title ?? ""
        let range = NSRange(rawTitle.startIndex..., in: rawTitle)
        if excludes.contains(where: { $0.firstMatch(in: rawTitle, range: range) != nil }) { continue }

        let title = (config.busyOnly ?? false) ? "Busy" : String(rawTitle.prefix(200))
        // Same meeting on two calendars keeps one id; occurrences differ by start time.
        let uid = event.calendarItemExternalIdentifier ?? event.eventIdentifier ?? UUID().uuidString
        var item: [String: Any] = ["uid": String(uid.prefix(300)), "title": title]
        if event.isAllDay {
            // EventKit ends all-day events just before midnight; the server wants an exclusive date.
            let startDay = cal.startOfDay(for: event.startDate)
            var endDay = cal.startOfDay(for: event.endDate)
            if endDay <= startDay || event.endDate > endDay { endDay = cal.date(byAdding: .day, value: 1, to: endDay)! }
            item["allDay"] = true
            item["startDate"] = ymd(startDay, cal)
            item["endDate"] = ymd(endDay, cal)
        } else {
            item["start"] = Int64(event.startDate.timeIntervalSince1970 * 1000)
            item["end"] = Int64(event.endDate.timeIntervalSince1970 * 1000)
        }
        out.append(item)
        if out.count >= 500 { break }
    }
    return out
}

// MARK: - Main

let args = Set(CommandLine.arguments.dropFirst())
let store = EKEventStore()

if args.contains("--request-access") {
    print(requestAccess(store) ? "Calendar access granted." : "Calendar access was not granted. Allow it in System Settings → Privacy & Security → Calendars.")
    exit(0)
}

// Only --request-access asks; a background run must never put up a prompt.
if !hasAccess() {
    fail("No Calendar access. Run: frame-push --request-access, or allow it in System Settings → Privacy & Security → Calendars")
}

if args.contains("--list-calendars") {
    for c in store.calendars(for: .event).sorted(by: { ($0.source.title, $0.title) < ($1.source.title, $1.title) }) {
        print("\(c.source.title)\t\(c.title)\t\(c.calendarIdentifier)")
    }
    exit(0)
}

let config = loadConfig()
let events = snapshot(store, config)
let body = try! JSONSerialization.data(withJSONObject: ["events": events], options: [.sortedKeys])

if args.contains("--dry-run") {
    FileHandle.standardOutput.write(body)
    print("")
    log("\(events.count) events (dry run, nothing sent)")
    exit(0)
}

guard let secret = token(for: config.pushId), !secret.isEmpty else {
    fail("No token in the login Keychain (service \(keychainService), account \(config.pushId)); run install.sh")
}
guard let base = URL(string: config.server), let scheme = base.scheme, scheme == "http" || scheme == "https" else {
    fail("server must be an http(s) URL")
}

var request = URLRequest(url: base.appendingPathComponent("api/push/\(config.pushId)"), timeoutInterval: 15)
request.httpMethod = "PUT"
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
request.httpBody = body

let done = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0
URLSession.shared.dataTask(with: request) { data, response, error in
    if let error = error {
        // Usually: away from home, or the server is down. Quiet; launchd tries again in 5 minutes.
        log("not sent (\(error.localizedDescription))")
    } else if let http = response as? HTTPURLResponse {
        if (200..<300).contains(http.statusCode) {
            log("sent \(events.count) events")
        } else {
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            log("server answered \(http.statusCode): \(text.prefix(200))")
            exitCode = 1
        }
    }
    done.signal()
}.resume()
done.wait()
exit(exitCode)
