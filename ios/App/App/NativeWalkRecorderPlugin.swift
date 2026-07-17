import ActivityKit
import Capacitor
import CoreLocation
import Foundation
import UIKit

private enum WalkSessionStatus: String, Codable {
    case recording
    case paused
    case stopped
}

private struct NativeWalkPoint: Codable {
    let latitude: Double
    let longitude: Double
    let accuracy: Double?
    let timestamp: Double
    let startsNewSegment: Bool
}

private struct NativeRadarTarget: Codable, Hashable {
    let id: String
    let name: String
    let emoji: String
    let latitude: Double
    let longitude: Double
    let isRouteStop: Bool
}

private struct NativeWalkContext: Codable, Equatable {
    var routeStops: [NativeRadarTarget]
    var radarCandidates: [NativeRadarTarget]
    var rangeMeters: Double
    var lockScreenEnabled: Bool

    var targets: [NativeRadarTarget] {
        var seen = Set<String>()
        return (routeStops + radarCandidates).filter { seen.insert($0.id).inserted }
    }
}

private struct NativeWalkSession: Codable {
    var schema: Int
    var sessionId: String
    var status: WalkSessionStatus
    var startedAt: Double
    var updatedAt: Double
    var endedAt: Double?
    var pausedAt: Double?
    var pausedMilliseconds: Double
    var distanceMeters: Double
    var points: [NativeWalkPoint]
    var context: NativeWalkContext
    /// Wall-clock receipt time for the last plausible Core Location callback.
    /// This is deliberately independent from accepted movement: a stationary
    /// walk still proves that the recorder is alive even when no route point is added.
    var lastRawFixAt: Double?
    /// Start/resume time protects the brief interval before the first fresh fix.
    var recordingActivatedAt: Double?
}

private struct NativeRadarBlip {
    let target: NativeRadarTarget
    let bearingDegrees: Double
    let distanceMeters: Double
}

private struct NativeRadarSnapshot {
    let nearest: NativeRadarBlip?
    let blips: [NativeRadarBlip]
}

private struct ParsedWalkContext {
    var routeStops: [NativeRadarTarget]?
    var radarCandidates: [NativeRadarTarget]?
    var rangeMeters: Double?
    var lockScreenEnabled: Bool?
}

private enum NativeWalkError: LocalizedError {
    case activeSession
    case noSession
    case sessionMismatch
    case permissionRequired
    case preciseLocationRequired
    case stoppedSession

    var errorDescription: String? {
        switch self {
        case .activeSession:
            return "Another walk is still active or waiting to be saved."
        case .noSession:
            return "There is no native walk session."
        case .sessionMismatch:
            return "The requested walk does not match the active session."
        case .permissionRequired:
            return "Location permission is required before recording a walk."
        case .preciseLocationRequired:
            return "Turn on Precise Location in Settings before recording a walk."
        case .stoppedSession:
            return "This walk has already stopped."
        }
    }
}

@objc(NativeWalkRecorderPlugin)
final class NativeWalkRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "NativeWalkRecorderPlugin"
    let jsName = "NativeWalkRecorder"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateContext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discard", returnType: CAPPluginReturnPromise)
    ]

    private var engine: NativeWalkEngine!
    private var pendingPermissionCalls: [CAPPluginCall] = []

    override func load() {
        engine = NativeWalkEngine()
        engine.onUpdate = { [weak self] payload in
            self?.notifyListeners("walkUpdate", data: payload)
        }
        engine.onAuthorizationChange = { [weak self] in
            self?.resolvePendingPermissionCalls()
        }
    }

    @objc override func checkPermissions(_ call: CAPPluginCall) {
        onMain { [weak self] in
            guard let self else { return }
            call.resolve(self.permissionPayload())
        }
    }

    @objc override func requestPermissions(_ call: CAPPluginCall) {
        onMain { [weak self] in
            guard let self else { return }
            if self.engine.authorizationStatus == .notDetermined {
                self.pendingPermissionCalls.append(call)
                self.engine.requestWhenInUsePermission()
            } else {
                call.resolve(self.permissionPayload())
            }
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        onMain { [weak self] in
            guard let self else { return }
            guard let sessionId = call.getString("sessionId"), !sessionId.isEmpty else {
                call.reject("sessionId is required.", "INVALID_ARGUMENT")
                return
            }

            do {
                let session = try self.engine.start(
                    sessionId: sessionId,
                    startedAt: Self.number(call.options["startedAt"]),
                    context: Self.parseContext(call.options)
                )
                call.resolve(self.engine.payload(for: session))
            } catch {
                self.reject(call, error: error)
            }
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        performSessionAction(call) { engine, sessionId in
            try engine.pause(sessionId: sessionId)
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        performSessionAction(call) { engine, sessionId in
            try engine.resume(sessionId: sessionId)
        }
    }

    @objc func updateContext(_ call: CAPPluginCall) {
        onMain { [weak self] in
            guard let self else { return }
            do {
                let session = try self.engine.updateContext(
                    sessionId: call.getString("sessionId"),
                    update: Self.parseContext(call.options)
                )
                // Context refreshes can be frequent and do not need to echo the
                // complete route history back across the Capacitor bridge.
                call.resolve(self.engine.payload(for: session, includePoints: false))
            } catch {
                self.reject(call, error: error)
            }
        }
    }

    @objc func snapshot(_ call: CAPPluginCall) {
        onMain { [weak self] in
            guard let self else { return }
            if let session = self.engine.session {
                call.resolve(self.engine.payload(for: session))
            } else {
                call.resolve(["session": NSNull()])
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        performSessionAction(call) { engine, sessionId in
            try engine.stop(sessionId: sessionId)
        }
    }

    @objc func acknowledge(_ call: CAPPluginCall) {
        onMain { [weak self] in
            guard let self else { return }
            do {
                try self.engine.acknowledge(sessionId: call.getString("sessionId"))
                call.resolve()
            } catch {
                self.reject(call, error: error)
            }
        }
    }

    @objc func discard(_ call: CAPPluginCall) {
        onMain { [weak self] in
            guard let self else { return }
            do {
                try self.engine.discard(sessionId: call.getString("sessionId"))
                call.resolve()
            } catch {
                self.reject(call, error: error)
            }
        }
    }

    private func performSessionAction(
        _ call: CAPPluginCall,
        action: @escaping (NativeWalkEngine, String?) throws -> NativeWalkSession
    ) {
        onMain { [weak self] in
            guard let self else { return }
            do {
                let session = try action(self.engine, call.getString("sessionId"))
                call.resolve(self.engine.payload(for: session))
            } catch {
                self.reject(call, error: error)
            }
        }
    }

    private func reject(_ call: CAPPluginCall, error: Error) {
        let code: String
        switch error {
        case NativeWalkError.permissionRequired:
            code = "LOCATION_PERMISSION_REQUIRED"
        case NativeWalkError.preciseLocationRequired:
            code = "PRECISE_LOCATION_REQUIRED"
        case NativeWalkError.sessionMismatch:
            code = "SESSION_MISMATCH"
        case NativeWalkError.activeSession:
            code = "ACTIVE_SESSION"
        case NativeWalkError.noSession:
            code = "NO_SESSION"
        case NativeWalkError.stoppedSession:
            code = "SESSION_STOPPED"
        default:
            code = "NATIVE_WALK_ERROR"
        }
        call.reject(error.localizedDescription, code, error)
    }

    private func resolvePendingPermissionCalls() {
        let calls = pendingPermissionCalls
        pendingPermissionCalls.removeAll()
        let payload = permissionPayload()
        calls.forEach { $0.resolve(payload) }
    }

    private func permissionPayload() -> [String: Any] {
        let state: String
        switch engine.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            state = "granted"
        case .notDetermined:
            state = "prompt"
        case .denied, .restricted:
            state = "denied"
        @unknown default:
            state = "prompt"
        }

        let activityKit = engine.activityKitDiagnostics()
        let lockScreenAvailable = activityKit["enabled"] as? Bool == true
        return [
            "location": state,
            "backgroundRecording": state,
            "lockScreen": lockScreenAvailable ? "granted" : "unavailable",
            "accuracy": engine.accuracyAuthorization == .fullAccuracy ? "full" : "reduced",
            "activityKit": activityKit
        ]
    }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    private static func parseContext(_ options: [AnyHashable: Any]) -> ParsedWalkContext {
        let nested = options["context"] as? [AnyHashable: Any]
        let routeValue = options["routeStops"] ?? nested?["routeStops"]
        let radarValue = options["radarCandidates"] ?? nested?["radarCandidates"]
        let targetsAlias = options["targets"] ?? nested?["targets"]

        var parsed = ParsedWalkContext()
        if routeValue != nil {
            parsed.routeStops = parseTargets(routeValue, routeStop: true)
        }
        if radarValue != nil || targetsAlias != nil {
            parsed.radarCandidates = parseTargets(radarValue ?? targetsAlias, routeStop: false)
        }
        parsed.rangeMeters = number(options["rangeM"] ?? nested?["rangeM"])
        parsed.lockScreenEnabled = bool(options["lockScreenEnabled"] ?? nested?["lockScreenEnabled"])
        return parsed
    }

    private static func parseTargets(_ value: Any?, routeStop: Bool) -> [NativeRadarTarget] {
        guard let rawTargets = value as? [Any] else { return [] }
        var seen = Set<String>()
        var targets: [NativeRadarTarget] = []
        for value in rawTargets {
            guard let raw = value as? [AnyHashable: Any],
                  let latitude = number(raw["latitude"] ?? raw["lat"]),
                  let longitude = number(raw["longitude"] ?? raw["lng"]),
                  (-90.0 ... 90.0).contains(latitude),
                  (-180.0 ... 180.0).contains(longitude) else {
                continue
            }
            if bool(raw["isCompleted"] ?? raw["completed"]) == true { continue }
            let rawName = string(raw["name"] ?? raw["n"] ?? raw["title"]) ?? "Nearby place"
            let name = String(rawName.prefix(80))
            let suppliedId = string(raw["id"])
            let id = suppliedId?.isEmpty == false
                ? suppliedId!
                : String(format: "%.5f:%.5f:%@", latitude, longitude, name)
            guard seen.insert(id).inserted else { continue }
            let fallbackEmoji = routeStop ? "◆" : "•"
            let emoji = String((string(raw["emoji"] ?? raw["e"]) ?? fallbackEmoji).prefix(8))
            targets.append(NativeRadarTarget(
                id: id,
                name: name,
                emoji: emoji,
                latitude: latitude,
                longitude: longitude,
                isRouteStop: routeStop
            ))
            // The web shell sends a city/corridor pool so radar remains useful
            // while the WebView is suspended. Keep a defensive, but generous cap.
            if targets.count == 2_000 { break }
        }
        return targets
    }

    private static func number(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? String { return Double(value) }
        return nil
    }

    private static func bool(_ value: Any?) -> Bool? {
        if let value = value as? Bool { return value }
        if let number = value as? NSNumber { return number.boolValue }
        if let value = value as? String {
            if value == "true" || value == "1" { return true }
            if value == "false" || value == "0" { return false }
        }
        return nil
    }

    private static func string(_ value: Any?) -> String? {
        value as? String
    }
}

private final class NativeWalkEngine: NSObject, CLLocationManagerDelegate {
    private static let maximumPointCount = 6_000
    private static let maximumStartLookbackMilliseconds = 3_600_000.0
    private static let maximumFixAgeMilliseconds = 120_000.0
    private static let maximumFutureFixMilliseconds = 10_000.0
    private static let vehicleEntrySpeedMetersPerSecond = 6.0
    private static let vehicleExitSpeedMetersPerSecond = 4.5
    private static let vehicleConfirmationSeconds = 20.0
    private static let vehicleExitSeconds = 10.0

    private let locationManager = CLLocationManager()
    private let storageURL: URL
    private var pendingSegment = false
    private var liveActivityController: AnyObject?
    private var lastCheckpointAt = Date.distantPast
    private var lastCheckpointDistance = -1.0
    private var lastCheckpointPointCount = -1
    private var lifecycleObservers: [NSObjectProtocol] = []
    private var locationAcceptanceFloorMilliseconds = 0.0
    private var motionReference: CLLocation?
    private var pendingFastLocations: [CLLocation] = []
    private var pendingFastStartedAt: Double?
    private var vehicleMotionDetected = false
    private var vehicleSlowStartedAt: Double?

    var onUpdate: (([String: Any]) -> Void)?
    var onAuthorizationChange: (() -> Void)?
    private(set) var session: NativeWalkSession?

    var authorizationStatus: CLAuthorizationStatus { locationManager.authorizationStatus }
    var accuracyAuthorization: CLAccuracyAuthorization { locationManager.accuracyAuthorization }

    override init() {
        storageURL = Self.makeStorageURL()
        super.init()
        locationManager.delegate = self
        locationManager.activityType = .fitness
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        // Raw callbacks are the crash-recovery heartbeat even when the user is
        // stationary; route-point noise is filtered separately in accept(_:into:).
        locationManager.distanceFilter = kCLDistanceFilterNone
        locationManager.pausesLocationUpdatesAutomatically = false
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.showsBackgroundLocationIndicator = true
        session = loadSession()
        installLifecycleObservers()
        if let recovered = session {
            lastCheckpointAt = Date(timeIntervalSince1970: recovered.updatedAt / 1_000)
            lastCheckpointDistance = recovered.distanceMeters
            lastCheckpointPointCount = recovered.points.count
        }

        if var recovered = session, recovered.status == .recording {
            let now = Date().timeIntervalSince1970 * 1_000
            let lastRecorderProof = max(
                recovered.lastRawFixAt ?? recovered.updatedAt,
                recovered.recordingActivatedAt ?? recovered.updatedAt
            )
            if now - lastRecorderProof > 120_000 {
                recovered.status = .paused
                recovered.pausedAt = max(recovered.startedAt, min(lastRecorderProof, now))
                recovered.updatedAt = now
                session = recovered
                pendingSegment = true
                persist(force: true)
            }
        }

        if var activeSession = session, activeSession.status == .recording, canRecordLocation {
            let now = Date().timeIntervalSince1970 * 1_000
            activeSession.recordingActivatedAt = now
            activeSession.updatedAt = now
            session = activeSession
            pendingSegment = true
            locationAcceptanceFloorMilliseconds = now - 1_000
            persist(force: true)
            locationManager.startUpdatingLocation()
        }
        if session != nil {
            refreshLiveActivity(force: true)
        }
    }

    deinit {
        lifecycleObservers.forEach(NotificationCenter.default.removeObserver)
    }

    func requestWhenInUsePermission() {
        locationManager.requestWhenInUseAuthorization()
    }

    func start(sessionId: String, startedAt: Double?, context update: ParsedWalkContext) throws -> NativeWalkSession {
        guard hasLocationPermission else { throw NativeWalkError.permissionRequired }
        guard accuracyAuthorization == .fullAccuracy else { throw NativeWalkError.preciseLocationRequired }
        if let existing = session {
            if existing.sessionId == sessionId && existing.status != .stopped {
                return try updateContext(sessionId: sessionId, update: update)
            }
            throw NativeWalkError.activeSession
        }

        let now = Date().timeIntervalSince1970 * 1_000
        let candidateStart = startedAt.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? now
        // A start tap should be contemporary. Clamp corrupted/future JS values while
        // retaining a bounded permission-sheet interval, which is excluded below.
        let validStart = min(now, max(now - Self.maximumStartLookbackMilliseconds, candidateStart))
        let context = NativeWalkContext(
            routeStops: update.routeStops ?? [],
            radarCandidates: update.radarCandidates ?? [],
            rangeMeters: clampedRange(update.rangeMeters ?? 800),
            lockScreenEnabled: update.lockScreenEnabled ?? true
        )
        let newSession = NativeWalkSession(
            schema: 1,
            sessionId: sessionId,
            status: .recording,
            startedAt: validStart,
            updatedAt: now,
            endedAt: nil,
            pausedAt: nil,
            // The web shell timestamps the tap before iOS presents its permission sheet.
            // Treat that pre-native interval as paused so first-run elapsed time starts at zero.
            pausedMilliseconds: max(0, now - validStart),
            distanceMeters: 0,
            points: [],
            context: context,
            lastRawFixAt: nil,
            recordingActivatedAt: now
        )
        session = newSession
        pendingSegment = false
        resetMotionFilter(acceptingLocationsAfter: now)
        persist(force: true)
        locationManager.startUpdatingLocation()
        refreshLiveActivity(force: true)
        emitUpdate()
        return newSession
    }

    func pause(sessionId: String?) throws -> NativeWalkSession {
        var current = try matchingSession(sessionId)
        guard current.status != .stopped else { throw NativeWalkError.stoppedSession }
        if current.status == .paused { return current }
        let now = Date().timeIntervalSince1970 * 1_000
        current.status = .paused
        current.pausedAt = now
        current.updatedAt = now
        session = current
        pendingSegment = true
        resetMotionFilter()
        locationManager.stopUpdatingLocation()
        persist(force: true)
        refreshLiveActivity(force: true)
        emitUpdate()
        return current
    }

    func resume(sessionId: String?) throws -> NativeWalkSession {
        guard hasLocationPermission else { throw NativeWalkError.permissionRequired }
        guard accuracyAuthorization == .fullAccuracy else { throw NativeWalkError.preciseLocationRequired }
        var current = try matchingSession(sessionId)
        guard current.status != .stopped else { throw NativeWalkError.stoppedSession }
        if current.status == .recording { return current }
        let now = Date().timeIntervalSince1970 * 1_000
        if let pausedAt = current.pausedAt {
            current.pausedMilliseconds += max(0, now - pausedAt)
        }
        current.status = .recording
        current.pausedAt = nil
        current.updatedAt = now
        current.recordingActivatedAt = now
        session = current
        pendingSegment = true
        resetMotionFilter(acceptingLocationsAfter: now)
        persist(force: true)
        locationManager.startUpdatingLocation()
        refreshLiveActivity(force: true)
        emitUpdate()
        return current
    }

    func updateContext(sessionId: String?, update: ParsedWalkContext) throws -> NativeWalkSession {
        var current = try matchingSession(sessionId)
        let oldContext = current.context
        if let routeStops = update.routeStops { current.context.routeStops = routeStops }
        if let radarCandidates = update.radarCandidates { current.context.radarCandidates = radarCandidates }
        if let rangeMeters = update.rangeMeters { current.context.rangeMeters = clampedRange(rangeMeters) }
        if let lockScreenEnabled = update.lockScreenEnabled { current.context.lockScreenEnabled = lockScreenEnabled }
        guard current.context != oldContext else { return current }
        current.updatedAt = Date().timeIntervalSince1970 * 1_000
        session = current
        // Coalesce large city/corridor context snapshots with the normal checkpoint
        // cadence. Lifecycle transitions force the newest context to disk.
        persist()
        refreshLiveActivity(force: true)
        emitUpdate()
        return current
    }

    func stop(sessionId: String?) throws -> NativeWalkSession {
        var current = try matchingSession(sessionId)
        if current.status == .stopped { return current }
        let now = Date().timeIntervalSince1970 * 1_000
        if let pausedAt = current.pausedAt {
            current.pausedMilliseconds += max(0, now - pausedAt)
        }
        current.status = .stopped
        current.pausedAt = nil
        current.endedAt = now
        current.updatedAt = now
        session = current
        pendingSegment = false
        resetMotionFilter()
        locationManager.stopUpdatingLocation()
        persist(force: true)
        refreshLiveActivity(force: true)
        emitUpdate(includePoints: true)
        return current
    }

    func acknowledge(sessionId: String?) throws {
        guard session != nil else { return }
        let current = try matchingSession(sessionId)
        guard current.status == .stopped else { throw NativeWalkError.activeSession }
        clearSession()
    }

    func discard(sessionId: String?) throws {
        guard session != nil else { return }
        _ = try matchingSession(sessionId)
        clearSession()
    }

    func payload(for session: NativeWalkSession, includePoints: Bool = true) -> [String: Any] {
        let radar = radarSnapshot(for: session)
        let blips: [[String: Any]] = radar.blips.map { blip in
            [
                "id": blip.target.id,
                "name": blip.target.name,
                "emoji": blip.target.emoji,
                "bearingDegrees": blip.bearingDegrees,
                "distanceMeters": blip.distanceMeters,
                "isRouteStop": blip.target.isRouteStop
            ]
        }
        var result: [String: Any] = [
            "sessionId": session.sessionId,
            "status": session.status.rawValue,
            "startedAt": session.startedAt,
            "updatedAt": session.updatedAt,
            "distanceMeters": session.distanceMeters,
            "elapsedSeconds": elapsedSeconds(for: session),
            "pausedMs": pausedMilliseconds(for: session),
            "lockScreenEnabled": session.context.lockScreenEnabled,
            "activityKit": activityKitDiagnostics(),
            "radar": [
                "rangeMeters": session.context.rangeMeters,
                "nearestName": radar.nearest?.target.name ?? NSNull(),
                "nearestDistanceMeters": radar.nearest?.distanceMeters ?? NSNull(),
                "blips": blips
            ]
        ]
        if let latest = session.points.last {
            result["latestPoint"] = [
                "latitude": latest.latitude,
                "longitude": latest.longitude,
                "accuracy": latest.accuracy.map { $0 as Any } ?? NSNull(),
                "timestamp": latest.timestamp,
                "startsNewSegment": latest.startsNewSegment
            ]
        }
        if includePoints {
            result["points"] = session.points.map { point in
                [
                    "latitude": point.latitude,
                    "longitude": point.longitude,
                    "accuracy": point.accuracy.map { $0 as Any } ?? NSNull(),
                    "timestamp": point.timestamp,
                    "startsNewSegment": point.startsNewSegment
                ]
            }
        }
        return result
    }

    func activityKitDiagnostics() -> [String: Any] {
        guard #available(iOS 16.1, *) else {
            return [
                "supported": false,
                "enabled": false,
                "state": "unsupported",
                "error": NSNull()
            ]
        }
        let enabled = ActivityAuthorizationInfo().areActivitiesEnabled
        if let controller = liveActivityController as? FlaneurLiveActivityController {
            return controller.diagnostics(authorizationEnabled: enabled)
        }
        return [
            "supported": true,
            "enabled": enabled,
            "state": enabled ? "ready" : "disabled",
            "error": NSNull()
        ]
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard var current = session, current.status == .recording else { return }
        let receiptTime = Date().timeIntervalSince1970 * 1_000
        var receivedPlausibleRawFix = false
        var accepted = false
        for location in locations.sorted(by: { $0.timestamp < $1.timestamp }) {
            guard isPlausibleRawFix(location, for: current, receiptTime: receiptTime) else { continue }
            receivedPlausibleRawFix = true
            // A coarse callback is valid recorder liveness, but must not become
            // the reference point for route distance or the motion classifier.
            guard location.horizontalAccuracy <= 65 else { continue }
            for candidate in distanceCandidates(for: location) {
                if accept(candidate, into: &current) { accepted = true }
            }
        }
        guard receivedPlausibleRawFix else { return }
        current.lastRawFixAt = receiptTime
        current.updatedAt = receiptTime
        session = current
        persist()
        refreshLiveActivity(force: false)
        if accepted { emitUpdate() }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if !canRecordLocation, var current = session, current.status == .recording {
            let now = Date().timeIntervalSince1970 * 1_000
            current.status = .paused
            current.pausedAt = now
            current.updatedAt = now
            session = current
            pendingSegment = true
            resetMotionFilter()
            manager.stopUpdatingLocation()
            persist(force: true)
            refreshLiveActivity(force: true)
            emitUpdate()
        }
        onAuthorizationChange?()
    }

    func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
        pendingSegment = true
        resetMotionFilter()
    }

    func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
        pendingSegment = true
        resetMotionFilter(acceptingLocationsAfter: Date().timeIntervalSince1970 * 1_000)
    }

    private var hasLocationPermission: Bool {
        authorizationStatus == .authorizedWhenInUse || authorizationStatus == .authorizedAlways
    }

    private var canRecordLocation: Bool {
        hasLocationPermission && accuracyAuthorization == .fullAccuracy
    }

    private func matchingSession(_ requestedId: String?) throws -> NativeWalkSession {
        guard let current = session else { throw NativeWalkError.noSession }
        if let requestedId, requestedId != current.sessionId { throw NativeWalkError.sessionMismatch }
        return current
    }

    private func accept(_ location: CLLocation, into session: inout NativeWalkSession) -> Bool {
        let accuracy = location.horizontalAccuracy
        guard accuracy >= 0, accuracy <= 65 else { return false }
        let timestamp = location.timestamp.timeIntervalSince1970 * 1_000
        let now = Date().timeIntervalSince1970 * 1_000
        guard timestamp.isFinite,
              timestamp >= session.startedAt,
              timestamp >= locationAcceptanceFloorMilliseconds,
              timestamp <= now + Self.maximumFutureFixMilliseconds else { return false }

        let point: NativeWalkPoint
        if let previous = session.points.last {
            let previousLocation = CLLocation(latitude: previous.latitude, longitude: previous.longitude)
            let distance = location.distance(from: previousLocation)
            let deltaSeconds = (timestamp - previous.timestamp) / 1_000
            guard deltaSeconds > 0 else { return false }
            let movementThreshold = max(12, accuracy / 2)
            let speed = distance / deltaSeconds
            guard distance >= movementThreshold, speed <= 12 else { return false }
            let gap = pendingSegment || deltaSeconds > 120 || (deltaSeconds > 30 && distance > 500)
            point = NativeWalkPoint(
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude,
                accuracy: accuracy,
                timestamp: timestamp,
                startsNewSegment: gap
            )
            if !gap { session.distanceMeters += distance }
        } else {
            point = NativeWalkPoint(
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude,
                accuracy: accuracy,
                timestamp: timestamp,
                startsNewSegment: false
            )
        }

        session.points.append(point)
        if session.points.count > Self.maximumPointCount {
            session.points = Array(session.points.suffix(Self.maximumPointCount))
            if let first = session.points.first {
                session.points[0] = NativeWalkPoint(
                    latitude: first.latitude,
                    longitude: first.longitude,
                    accuracy: first.accuracy,
                    timestamp: first.timestamp,
                    startsNewSegment: true
                )
            }
        }
        pendingSegment = false
        return true
    }

    private func isPlausibleRawFix(
        _ location: CLLocation,
        for session: NativeWalkSession,
        receiptTime: Double
    ) -> Bool {
        let coordinate = location.coordinate
        let timestamp = location.timestamp.timeIntervalSince1970 * 1_000
        let accuracy = location.horizontalAccuracy
        return coordinate.latitude.isFinite
            && coordinate.longitude.isFinite
            && (-90.0 ... 90.0).contains(coordinate.latitude)
            && (-180.0 ... 180.0).contains(coordinate.longitude)
            && accuracy.isFinite
            && accuracy >= 0
            && accuracy <= 1_000
            && timestamp.isFinite
            && timestamp >= session.startedAt
            && timestamp >= locationAcceptanceFloorMilliseconds
            && timestamp >= receiptTime - Self.maximumFixAgeMilliseconds
            && timestamp <= receiptTime + Self.maximumFutureFixMilliseconds
    }

    /// Buffers sustained running-edge speeds before deciding they are vehicular.
    /// Short bursts are replayed into the normal point filter, preserving runners;
    /// movement above 21.6 km/h for 20 seconds is treated as vehicle contamination.
    private func distanceCandidates(for location: CLLocation) -> [CLLocation] {
        guard let reference = motionReference else {
            motionReference = location
            return [location]
        }
        let deltaSeconds = location.timestamp.timeIntervalSince(reference.timestamp)
        guard deltaSeconds > 0 else { return [] }
        let speed = location.distance(from: reference) / deltaSeconds
        guard speed.isFinite else { return [] }

        // An implausibly fast jump is more likely a GPS outlier than a vehicle.
        // Keep the last trustworthy motion reference so the next real fix recovers.
        if speed > 12 {
            if !pendingFastLocations.isEmpty {
                pendingFastLocations.removeAll(keepingCapacity: true)
                pendingFastStartedAt = nil
                pendingSegment = true
            }
            return []
        }

        motionReference = location
        if vehicleMotionDetected {
            if speed <= Self.vehicleExitSpeedMetersPerSecond {
                let timestamp = location.timestamp.timeIntervalSince1970
                if vehicleSlowStartedAt == nil { vehicleSlowStartedAt = timestamp }
                if timestamp - (vehicleSlowStartedAt ?? timestamp) >= Self.vehicleExitSeconds {
                    vehicleMotionDetected = false
                    vehicleSlowStartedAt = nil
                    pendingSegment = true
                    return [location]
                }
            } else {
                vehicleSlowStartedAt = nil
            }
            return []
        }

        if speed >= Self.vehicleEntrySpeedMetersPerSecond {
            if pendingFastLocations.isEmpty {
                pendingFastStartedAt = reference.timestamp.timeIntervalSince1970
            }
            pendingFastLocations.append(location)
            let timestamp = location.timestamp.timeIntervalSince1970
            if timestamp - (pendingFastStartedAt ?? timestamp) >= Self.vehicleConfirmationSeconds {
                pendingFastLocations.removeAll(keepingCapacity: true)
                pendingFastStartedAt = nil
                vehicleMotionDetected = true
                vehicleSlowStartedAt = nil
                pendingSegment = true
            }
            return []
        }

        if !pendingFastLocations.isEmpty {
            let candidates = pendingFastLocations + [location]
            pendingFastLocations.removeAll(keepingCapacity: true)
            pendingFastStartedAt = nil
            return candidates
        }
        return [location]
    }

    private func resetMotionFilter(acceptingLocationsAfter timestamp: Double? = nil) {
        motionReference = nil
        pendingFastLocations.removeAll(keepingCapacity: true)
        pendingFastStartedAt = nil
        vehicleMotionDetected = false
        vehicleSlowStartedAt = nil
        if let timestamp {
            // Allow a tiny sampling skew, but never a cached pre-start/pre-resume fix.
            locationAcceptanceFloorMilliseconds = timestamp - 1_000
        }
    }

    private func elapsedSeconds(for session: NativeWalkSession) -> Int {
        let now = session.endedAt ?? Date().timeIntervalSince1970 * 1_000
        return max(0, Int((now - session.startedAt - pausedMilliseconds(for: session)) / 1_000))
    }

    private func pausedMilliseconds(for session: NativeWalkSession) -> Double {
        let now = session.endedAt ?? Date().timeIntervalSince1970 * 1_000
        var paused = session.pausedMilliseconds
        if let pausedAt = session.pausedAt { paused += max(0, now - pausedAt) }
        return paused
    }

    private func radarSnapshot(for session: NativeWalkSession) -> NativeRadarSnapshot {
        guard let point = session.points.last else {
            return NativeRadarSnapshot(nearest: nil, blips: [])
        }
        let origin = CLLocationCoordinate2D(latitude: point.latitude, longitude: point.longitude)
        let pointLocation = CLLocation(latitude: point.latitude, longitude: point.longitude)
        var nearest: NativeRadarBlip?
        var visible: [NativeRadarBlip] = []
        for target in session.context.targets {
            let targetLocation = CLLocation(latitude: target.latitude, longitude: target.longitude)
            let blip = NativeRadarBlip(
                target: target,
                bearingDegrees: Self.bearing(from: origin, to: targetLocation.coordinate),
                distanceMeters: pointLocation.distance(from: targetLocation)
            )
            if nearest == nil || radarPrecedes(blip, nearest!) { nearest = blip }
            if blip.distanceMeters <= session.context.rangeMeters {
                visible.append(blip)
                visible.sort(by: radarPrecedes)
                if visible.count > 3 { visible.removeLast() }
            }
        }
        return NativeRadarSnapshot(nearest: nearest, blips: visible)
    }

    private func radarPrecedes(_ lhs: NativeRadarBlip, _ rhs: NativeRadarBlip) -> Bool {
        if lhs.distanceMeters == rhs.distanceMeters {
            return lhs.target.isRouteStop && !rhs.target.isRouteStop
        }
        return lhs.distanceMeters < rhs.distanceMeters
    }

    private func emitUpdate(includePoints: Bool = false) {
        guard let session else { return }
        onUpdate?(payload(for: session, includePoints: includePoints))
    }

    private func persist(force: Bool = false) {
        guard let session else { return }
        let now = Date()
        if !force, lastCheckpointPointCount >= 0 {
            let firstAcceptedPoint = lastCheckpointPointCount == 0 && !session.points.isEmpty
            let dueByTime = now.timeIntervalSince(lastCheckpointAt) >= 30
            let dueByDistance = abs(session.distanceMeters - lastCheckpointDistance) >= 100
            let dueByCount = session.points.count - lastCheckpointPointCount >= 25
            guard firstAcceptedPoint || dueByTime || dueByDistance || dueByCount else { return }
        }
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let data = try encoder.encode(session)
            try data.write(to: storageURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            Self.excludeFromBackup(storageURL)
            lastCheckpointAt = now
            lastCheckpointDistance = session.distanceMeters
            lastCheckpointPointCount = session.points.count
        } catch {
            NSLog("Flaneur walk checkpoint failed: %@", error.localizedDescription)
        }
    }

    private func installLifecycleObservers() {
        let center = NotificationCenter.default
        let checkpointNames: [Notification.Name] = [
            UIApplication.didEnterBackgroundNotification,
            UIApplication.willTerminateNotification,
            UIApplication.protectedDataWillBecomeUnavailableNotification
        ]
        lifecycleObservers = checkpointNames.map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.persist(force: true)
                self?.refreshLiveActivity(force: true)
            }
        }
    }

    private func loadSession() -> NativeWalkSession? {
        do {
            let data = try Data(contentsOf: storageURL)
            var decoded = try JSONDecoder().decode(NativeWalkSession.self, from: data)
            guard decoded.schema == 1 else { return nil }
            let now = Date().timeIntervalSince1970 * 1_000
            guard decoded.startedAt.isFinite,
                  decoded.startedAt > 0,
                  decoded.startedAt <= now + Self.maximumFutureFixMilliseconds else { return nil }
            decoded.updatedAt = decoded.updatedAt.isFinite
                ? min(now, max(decoded.startedAt, decoded.updatedAt))
                : decoded.startedAt
            if let endedAt = decoded.endedAt {
                decoded.endedAt = endedAt.isFinite && endedAt >= decoded.startedAt
                    ? min(now, endedAt)
                    : nil
            }
            if let pausedAt = decoded.pausedAt {
                decoded.pausedAt = pausedAt.isFinite && pausedAt >= decoded.startedAt
                    ? min(now, pausedAt)
                    : nil
            }
            let sessionEnd = decoded.endedAt ?? now
            let maximumPause = max(0, sessionEnd - decoded.startedAt)
            decoded.pausedMilliseconds = decoded.pausedMilliseconds.isFinite
                ? min(maximumPause, max(0, decoded.pausedMilliseconds))
                : 0
            decoded.distanceMeters = decoded.distanceMeters.isFinite
                ? max(0, decoded.distanceMeters)
                : 0
            decoded.lastRawFixAt = decoded.lastRawFixAt.flatMap { value in
                value.isFinite && value >= decoded.startedAt && value <= now + Self.maximumFutureFixMilliseconds
                    ? min(now, value)
                    : nil
            }
            decoded.recordingActivatedAt = decoded.recordingActivatedAt.flatMap { value in
                value.isFinite && value >= decoded.startedAt && value <= now + Self.maximumFutureFixMilliseconds
                    ? min(now, value)
                    : nil
            }

            var lastTimestamp = decoded.startedAt.nextDown
            decoded.points = decoded.points.filter { point in
                let valid = point.latitude.isFinite
                    && point.longitude.isFinite
                    && (-90.0 ... 90.0).contains(point.latitude)
                    && (-180.0 ... 180.0).contains(point.longitude)
                    && point.timestamp.isFinite
                    && point.timestamp >= decoded.startedAt
                    && point.timestamp <= now + Self.maximumFutureFixMilliseconds
                    && point.timestamp > lastTimestamp
                if valid { lastTimestamp = point.timestamp }
                return valid
            }
            if decoded.points.count > Self.maximumPointCount {
                decoded.points = Array(decoded.points.suffix(Self.maximumPointCount))
                if let first = decoded.points.first {
                    decoded.points[0] = NativeWalkPoint(
                        latitude: first.latitude,
                        longitude: first.longitude,
                        accuracy: first.accuracy,
                        timestamp: first.timestamp,
                        startsNewSegment: true
                    )
                }
            }
            decoded.context.routeStops = Array(decoded.context.routeStops.prefix(2_000))
            decoded.context.radarCandidates = Array(decoded.context.radarCandidates.prefix(2_000))
            return decoded
        } catch CocoaError.fileReadNoSuchFile {
            return nil
        } catch {
            NSLog("Flaneur walk recovery failed: %@", error.localizedDescription)
            return nil
        }
    }

    private func clearSession() {
        locationManager.stopUpdatingLocation()
        session = nil
        pendingSegment = false
        resetMotionFilter()
        try? FileManager.default.removeItem(at: storageURL)
        if #available(iOS 16.1, *), let controller = liveActivityController as? FlaneurLiveActivityController {
            controller.endImmediately()
        }
        liveActivityController = nil
    }

    private func refreshLiveActivity(force: Bool) {
        guard let session else { return }
        if #available(iOS 16.1, *) {
            let controller: FlaneurLiveActivityController
            if let existing = liveActivityController as? FlaneurLiveActivityController {
                controller = existing
            } else {
                controller = FlaneurLiveActivityController()
                liveActivityController = controller
            }
            controller.sync(
                session: session,
                elapsedSeconds: elapsedSeconds(for: session),
                force: force,
                radar: { self.radarSnapshot(for: session) }
            )
        }
    }

    private func clampedRange(_ value: Double) -> Double {
        min(5_000, max(100, value.isFinite ? value : 800))
    }

    private static func makeStorageURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = base.appendingPathComponent("FlaneurWalk", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
            )
        } catch {
            NSLog("Flaneur walk storage setup failed: %@", error.localizedDescription)
        }
        excludeFromBackup(directory)
        return directory.appendingPathComponent("active-session.json", isDirectory: false)
    }

    private static func excludeFromBackup(_ url: URL) {
        var mutableURL = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try mutableURL.setResourceValues(values)
        } catch {
            NSLog("Flaneur walk backup exclusion failed: %@", error.localizedDescription)
        }
    }

    private static func bearing(from origin: CLLocationCoordinate2D, to target: CLLocationCoordinate2D) -> Double {
        let latitude1 = origin.latitude * .pi / 180
        let latitude2 = target.latitude * .pi / 180
        let longitudeDelta = (target.longitude - origin.longitude) * .pi / 180
        let y = sin(longitudeDelta) * cos(latitude2)
        let x = cos(latitude1) * sin(latitude2) - sin(latitude1) * cos(latitude2) * cos(longitudeDelta)
        return (atan2(y, x) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
    }
}

@available(iOS 16.1, *)
private final class FlaneurLiveActivityController {
    private var activity: Activity<FlaneurWalkActivityAttributes>?
    private var lastUpdate = Date.distantPast
    private var lastDistance = -1.0
    private var lastStatus = ""
    private var lifecycleState = "idle"
    private var lastErrorMessage: String?

    init() {
        activity = nil
    }

    func diagnostics(authorizationEnabled: Bool) -> [String: Any] {
        let state: String
        if let lastErrorMessage, !lastErrorMessage.isEmpty {
            state = "error"
        } else if activity != nil {
            state = "active"
        } else if !authorizationEnabled {
            state = "disabled"
        } else {
            state = lifecycleState
        }
        return [
            "supported": true,
            "enabled": authorizationEnabled,
            "state": state,
            "error": lastErrorMessage ?? NSNull()
        ]
    }

    func sync(
        session: NativeWalkSession,
        elapsedSeconds: Int,
        force: Bool,
        radar: () -> NativeRadarSnapshot
    ) {
        if activity?.attributes.sessionId != session.sessionId {
            activity = Activity<FlaneurWalkActivityAttributes>.activities.first {
                $0.attributes.sessionId == session.sessionId
            }
            if activity != nil {
                lifecycleState = "active"
                lastErrorMessage = nil
            }
        }
        guard session.context.lockScreenEnabled, session.status != .stopped else {
            lifecycleState = session.status == .stopped ? "ended" : "disabledForWalk"
            endImmediately(state: makeState(session: session, radar: radar(), elapsedSeconds: elapsedSeconds))
            return
        }

        if activity == nil {
            guard UIApplication.shared.applicationState == .active else {
                lifecycleState = "waitingForForeground"
                return
            }
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                lifecycleState = "disabled"
                return
            }
            do {
                let state = makeState(session: session, radar: radar(), elapsedSeconds: elapsedSeconds)
                let attributes = FlaneurWalkActivityAttributes(sessionId: session.sessionId, title: "Walk radar")
                if #available(iOS 16.2, *) {
                    let staleDate = session.status == .paused ? nil : Date().addingTimeInterval(180)
                    activity = try Activity.request(
                        attributes: attributes,
                        content: ActivityContent(state: state, staleDate: staleDate),
                        pushType: nil
                    )
                } else {
                    activity = try Activity.request(
                        attributes: attributes,
                        contentState: state,
                        pushType: nil
                    )
                }
                lastUpdate = Date()
                lastDistance = session.distanceMeters
                lastStatus = session.status.rawValue
                lifecycleState = "active"
                lastErrorMessage = nil
            } catch {
                lifecycleState = "error"
                lastErrorMessage = error.localizedDescription
                NSLog("Flaneur Live Activity start failed: %@", error.localizedDescription)
            }
            return
        }

        let enoughTime = Date().timeIntervalSince(lastUpdate) >= 20
        let enoughMovement = abs(session.distanceMeters - lastDistance) >= 25
        let statusChanged = session.status.rawValue != lastStatus
        guard force || enoughTime || enoughMovement || statusChanged else { return }
        let state = makeState(session: session, radar: radar(), elapsedSeconds: elapsedSeconds)
        lastUpdate = Date()
        lastDistance = session.distanceMeters
        lastStatus = session.status.rawValue
        lifecycleState = "active"
        guard let activity else { return }
        Task {
            if #available(iOS 16.2, *) {
                let staleDate = session.status == .paused ? nil : Date().addingTimeInterval(180)
                await activity.update(ActivityContent(state: state, staleDate: staleDate))
            } else {
                await activity.update(using: state)
            }
        }
    }

    func endImmediately() {
        endImmediately(state: nil)
    }

    private func endImmediately(state: FlaneurWalkActivityAttributes.ContentState?) {
        lifecycleState = "ended"
        lastErrorMessage = nil
        guard let activity else { return }
        self.activity = nil
        let finalState = state ?? FlaneurWalkActivityAttributes.ContentState(
            status: "stopped",
            timerAnchorMilliseconds: Date().timeIntervalSince1970 * 1_000,
            elapsedSeconds: 0,
            distanceMeters: 0,
            nearestName: "",
            nearestDistanceMeters: -1,
            radarRangeMeters: 800,
            blips: []
        )
        Task {
            if #available(iOS 16.2, *) {
                await activity.end(ActivityContent(state: finalState, staleDate: nil), dismissalPolicy: .immediate)
            } else {
                await activity.end(using: finalState, dismissalPolicy: .immediate)
            }
        }
    }

    private func makeState(
        session: NativeWalkSession,
        radar: NativeRadarSnapshot,
        elapsedSeconds: Int
    ) -> FlaneurWalkActivityAttributes.ContentState {
        let now = Date().timeIntervalSince1970 * 1_000
        let blips = radar.blips.map { blip in
            FlaneurWalkActivityAttributes.RadarBlip(
                id: blip.target.id,
                name: blip.target.name,
                emoji: blip.target.emoji,
                bearingDegrees: blip.bearingDegrees,
                distanceMeters: blip.distanceMeters,
                isRouteStop: blip.target.isRouteStop
            )
        }
        return FlaneurWalkActivityAttributes.ContentState(
            status: session.status.rawValue,
            timerAnchorMilliseconds: now - Double(elapsedSeconds * 1_000),
            elapsedSeconds: elapsedSeconds,
            distanceMeters: session.distanceMeters,
            nearestName: radar.nearest?.target.name ?? "",
            nearestDistanceMeters: radar.nearest?.distanceMeters ?? -1,
            radarRangeMeters: session.context.rangeMeters,
            blips: blips
        )
    }
}
