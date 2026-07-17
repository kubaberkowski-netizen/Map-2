import Foundation

enum WatchSessionState: String, Codable, Sendable {
    case idle, recording, paused, ending, ended

    init(from decoder: Decoder) throws {
        let rawValue = try decoder.singleValueContainer().decode(String.self)
        self = rawValue == "stopped" ? .ended : (WatchSessionState(rawValue: rawValue) ?? .idle)
    }
}

struct WatchCoordinate: Codable, Hashable, Sendable {
    let latitude: Double
    let longitude: Double
    let accuracy: Double?
    let timestamp: Double?
}

struct WatchRadarTarget: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let latitude: Double
    let longitude: Double
    let category: String?
    var isCheckedIn: Bool

    private enum CodingKeys: String, CodingKey {
        case id, name, latitude, longitude, category
        case isCheckedIn, isCompleted, isVisited
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? "Place"
        latitude = try container.decode(Double.self, forKey: .latitude)
        longitude = try container.decode(Double.self, forKey: .longitude)
        category = try container.decodeIfPresent(String.self, forKey: .category)
        isCheckedIn = try container.decodeIfPresent(Bool.self, forKey: .isCheckedIn)
            ?? container.decodeIfPresent(Bool.self, forKey: .isCompleted)
            ?? container.decodeIfPresent(Bool.self, forKey: .isVisited)
            ?? false
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(latitude, forKey: .latitude)
        try container.encode(longitude, forKey: .longitude)
        try container.encodeIfPresent(category, forKey: .category)
        try container.encode(isCheckedIn, forKey: .isCheckedIn)
    }
}

struct WatchSessionSnapshot: Codable, Hashable, Sendable {
    static let currentSchema = 1

    let schema: Int
    let sessionId: String
    var state: WatchSessionState
    let startedAt: Double
    var elapsedSeconds: Double
    var distanceMeters: Double
    var currentLocation: WatchCoordinate?
    var routeStops: [WatchRadarTarget]
    var nearbyTargets: [WatchRadarTarget]
    var nextStopId: String?
    var radarRangeMeters: Int
    var updatedAt: Double

    var nextStop: WatchRadarTarget? {
        guard let nextStopId else { return nil }
        return routeStops.first(where: { $0.id == nextStopId })
            ?? nearbyTargets.first(where: { $0.id == nextStopId })
    }

    var radarTargets: [WatchRadarTarget] {
        var seen = Set<String>()
        return (routeStops + nearbyTargets).filter { seen.insert($0.id).inserted }
    }

    func elapsed(at date: Date) -> TimeInterval {
        guard state == .recording else { return elapsedSeconds }
        let received = Date(timeIntervalSince1970: updatedAt / 1_000)
        return elapsedSeconds + max(0, date.timeIntervalSince(received))
    }

    func isStale(at date: Date, after interval: TimeInterval = 20) -> Bool {
        guard updatedAt > 0 else { return true }
        return date.timeIntervalSince1970 - (updatedAt / 1_000) > interval
    }

    mutating func applyAcknowledged(_ command: WatchCommandKind, spotId: String?) {
        switch command {
        case .pause: state = .paused
        case .resume: state = .recording
        case .end: state = .ending
        case .checkIn:
            guard let spotId else { return }
            if let index = routeStops.firstIndex(where: { $0.id == spotId }) {
                routeStops[index].isCheckedIn = true
            }
            if let index = nearbyTargets.firstIndex(where: { $0.id == spotId }) {
                nearbyTargets[index].isCheckedIn = true
            }
        }
    }

    static func normalizedRadarRange(_ value: Int) -> Int {
        [150, 300, 600].min(by: { abs($0 - value) < abs($1 - value) }) ?? 300
    }
}

enum WatchCommandKind: String, Codable, Sendable {
    case pause, resume, end, checkIn
}

struct WatchCommandRequest: Encodable, Sendable {
    let kind = "command"
    let schema = WatchSessionSnapshot.currentSchema
    let commandId: String
    let command: WatchCommandKind
    let sessionId: String
    let spotId: String?
}

struct WatchCommandAcknowledgement: Codable, Sendable {
    let kind: String?
    let schema: Int?
    let commandId: String
    let success: Bool
    let error: String?
    let snapshot: WatchSessionSnapshot?
}

struct PendingWatchCommand: Identifiable, Equatable, Sendable {
    let id: String
    let command: WatchCommandKind
    let spotId: String?
    let sentAt: Date

    var progressLabel: String {
        switch command {
        case .pause: return "Pausing…"
        case .resume: return "Resuming…"
        case .end: return "Ending…"
        case .checkIn: return "Checking in…"
        }
    }
}
