import Foundation
import WatchConnectivity

/// Owns the phone side of the paired Watch session for the lifetime of the app.
///
/// The latest walk snapshot is persisted by WatchConnectivity as application
/// context. Commands travel in the opposite direction and are acknowledged only
/// after the web walk state has handled them.
final class WatchSessionCoordinator: NSObject {
    static let shared = WatchSessionCoordinator()

    typealias CommandHandler = ([String: Any]) -> Void

    private let stateQueue = DispatchQueue(label: "com.kubaberkowski.flaneur.watch-session")
    private var commandHandler: CommandHandler?
    private var queuedCommands: [[String: Any]] = []
    private var queuedCommandIDs = Set<String>()
    private var acknowledgedCommands: [String: [String: Any]] = [:]
    private var recentAcknowledgementIDs: [String] = []
    private var latestSnapshot: [String: Any]?

    private override init() {
        super.init()
    }

    var isSupported: Bool {
        WCSession.isSupported()
    }

    var isReachable: Bool {
        isSupported && WCSession.default.isReachable
    }

    func activate() {
        guard isSupported else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    func setCommandHandler(_ handler: @escaping CommandHandler) {
        stateQueue.async {
            self.commandHandler = handler
            let commands = self.queuedCommands
            self.queuedCommands.removeAll()

            guard !commands.isEmpty else { return }
            DispatchQueue.main.async {
                commands.forEach(handler)
            }
        }
    }

    func removeCommandHandler() {
        stateQueue.async {
            self.commandHandler = nil
        }
    }

    func publish(snapshot: [String: Any]) throws {
        guard isSupported else { throw WatchSessionError.unsupported }
        guard let safeSnapshot = Self.propertyListDictionary(snapshot) else {
            throw WatchSessionError.invalidPayload
        }

        stateQueue.sync {
            self.latestSnapshot = safeSnapshot
        }

        try deliver(snapshot: safeSnapshot)
    }

    /// Merges recorder-owned metrics into the last web-published session. This
    /// keeps Watch state moving even while WKWebView JavaScript is suspended.
    func consumeNativeWalkUpdate(
        _ update: [String: Any],
        nativeSnapshot: [String: Any]? = nil,
        completion: (([String: Any]?) -> Void)? = nil
    ) {
        guard let safeUpdate = Self.propertyListDictionary(update),
              let sessionID = safeUpdate["sessionId"] as? String,
              !sessionID.isEmpty else {
            completion?(nil)
            return
        }
        let safeNativeSnapshot = nativeSnapshot.flatMap(Self.propertyListDictionary)

        stateQueue.async {
            if let publishedSessionID = self.latestSnapshot?["sessionId"] as? String,
               publishedSessionID != sessionID,
               safeNativeSnapshot?["sessionId"] as? String != sessionID {
                DispatchQueue.main.async { completion?(nil) }
                return
            }

            let publishedSnapshot = (self.latestSnapshot?["sessionId"] as? String == sessionID)
                ? self.latestSnapshot
                : nil
            var snapshot = publishedSnapshot ?? safeNativeSnapshot ?? [
                "schema": 1,
                "sessionId": sessionID,
                "state": safeUpdate["status"] as? String ?? "recording",
                "startedAt": safeUpdate["startedAt"] ?? Date().timeIntervalSince1970 * 1_000,
                "elapsedSeconds": safeUpdate["elapsedSeconds"] ?? 0,
                "distanceMeters": safeUpdate["distanceMeters"] ?? 0,
                "routeStops": [],
                "nearbyTargets": [],
                "radarRangeMeters": 300,
                "updatedAt": safeUpdate["updatedAt"] ?? Date().timeIntervalSince1970 * 1_000
            ]

            snapshot["schema"] = 1
            snapshot["sessionId"] = sessionID
            if let status = safeUpdate["status"] as? String {
                snapshot["state"] = status == "stopped" ? "ended" : status
            }
            for key in ["startedAt", "elapsedSeconds", "distanceMeters", "updatedAt"] {
                if let value = safeUpdate[key] {
                    snapshot[key] = value
                }
            }
            if let latestPoint = safeUpdate["latestPoint"] as? [String: Any] {
                snapshot["currentLocation"] = latestPoint
            }
            if let radar = safeUpdate["radar"] as? [String: Any],
               let range = radar["rangeMeters"] {
                snapshot["radarRangeMeters"] = range
            }

            self.latestSnapshot = snapshot
            try? self.deliver(snapshot: snapshot)
            DispatchQueue.main.async { completion?(snapshot) }
        }
    }

    private func deliver(snapshot safeSnapshot: [String: Any]) throws {
        let envelope: [String: Any] = [
            "kind": "sessionSnapshot",
            "schema": 1,
            "snapshot": safeSnapshot,
            "sentAt": Date().timeIntervalSince1970 * 1_000
        ]

        let session = WCSession.default
        try session.updateApplicationContext(envelope)
        sendImmediatelyWhenReachable(envelope)
    }

    func clear() throws {
        guard isSupported else { throw WatchSessionError.unsupported }
        let envelope: [String: Any] = [
            "kind": "sessionCleared",
            "schema": 1,
            "sentAt": Date().timeIntervalSince1970 * 1_000
        ]

        stateQueue.sync {
            self.latestSnapshot = nil
        }

        let session = WCSession.default
        try session.updateApplicationContext(envelope)
        sendImmediatelyWhenReachable(envelope)
    }

    func acknowledge(
        commandID: String,
        success: Bool,
        error: String?,
        snapshot: [String: Any]?,
        retainCommandForWeb: Bool = false
    ) throws {
        guard isSupported else { throw WatchSessionError.unsupported }
        guard !commandID.isEmpty else { throw WatchSessionError.invalidPayload }

        var envelope: [String: Any] = [
            "kind": "commandAck",
            "schema": 1,
            "commandId": commandID,
            "success": success,
            "sentAt": Date().timeIntervalSince1970 * 1_000
        ]
        if let error, !error.isEmpty {
            envelope["error"] = error
        }
        if let snapshot {
            guard let safeSnapshot = Self.propertyListDictionary(snapshot) else {
                throw WatchSessionError.invalidPayload
            }
            envelope["snapshot"] = safeSnapshot
        }

        stateQueue.async {
            if !retainCommandForWeb {
                self.queuedCommandIDs.remove(commandID)
                self.queuedCommands.removeAll { $0["commandId"] as? String == commandID }
            }
            self.acknowledgedCommands[commandID] = envelope
            self.recentAcknowledgementIDs.removeAll { $0 == commandID }
            self.recentAcknowledgementIDs.append(commandID)
            while self.recentAcknowledgementIDs.count > 50 {
                let expiredID = self.recentAcknowledgementIDs.removeFirst()
                self.acknowledgedCommands.removeValue(forKey: expiredID)
            }
        }

        deliverAcknowledgement(envelope)
    }

    func status() -> [String: Any] {
        guard isSupported else {
            return ["supported": false, "reachable": false, "activationState": "unsupported"]
        }
        let session = WCSession.default
        let activationState: String
        switch session.activationState {
        case .notActivated: activationState = "notActivated"
        case .inactive: activationState = "inactive"
        case .activated: activationState = "activated"
        @unknown default: activationState = "unknown"
        }
        return [
            "supported": true,
            "paired": session.isPaired,
            "watchAppInstalled": session.isWatchAppInstalled,
            "reachable": session.isReachable,
            "activationState": activationState
        ]
    }

    private func sendImmediatelyWhenReachable(_ message: [String: Any]) {
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage(message, replyHandler: nil) { _ in
            // The application context already retains the latest state.
        }
    }

    private func deliverAcknowledgement(_ envelope: [String: Any]) {
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else {
            session.transferUserInfo(envelope)
            return
        }

        session.sendMessage(envelope, replyHandler: nil) { _ in
            session.transferUserInfo(envelope)
        }
    }

    private func receiveCommand(_ message: [String: Any]) {
        guard message["kind"] as? String == "command",
              (message["schema"] as? NSNumber)?.intValue == 1 || message["schema"] as? Int == 1,
              let commandID = message["commandId"] as? String,
              !commandID.isEmpty,
              let command = message["command"] as? String,
              ["pause", "resume", "end", "checkIn"].contains(command),
              let safeMessage = Self.propertyListDictionary(message) else {
            return
        }

        stateQueue.async {
            if let acknowledgement = self.acknowledgedCommands[commandID] {
                self.deliverAcknowledgement(acknowledgement)
                return
            }
            guard !self.queuedCommandIDs.contains(commandID) else { return }

            self.queuedCommandIDs.insert(commandID)
            if ["pause", "resume", "end"].contains(command) {
                DispatchQueue.main.async {
                    self.executeNativeCommand(safeMessage)
                }
            }

            if let handler = self.commandHandler {
                DispatchQueue.main.async {
                    handler(safeMessage)
                }
            } else {
                self.queuedCommands.append(safeMessage)
            }
        }
    }

    private func executeNativeCommand(_ message: [String: Any]) {
        guard let commandID = message["commandId"] as? String,
              let command = message["command"] as? String,
              let sessionID = message["sessionId"] as? String else {
            return
        }

        do {
            let update = try NativeWalkRecorderPlugin.executeWatchCommand(
                command,
                sessionId: sessionID
            )
            consumeNativeWalkUpdate(
                update,
                nativeSnapshot: NativeWalkRecorderPlugin.watchSnapshot()
            ) { snapshot in
                try? self.acknowledge(
                    commandID: commandID,
                    success: true,
                    error: nil,
                    snapshot: snapshot,
                    retainCommandForWeb: true
                )
            }
        } catch {
            try? acknowledge(
                commandID: commandID,
                success: false,
                error: error.localizedDescription,
                snapshot: nil,
                retainCommandForWeb: true
            )
        }
    }

    private static func propertyListDictionary(_ dictionary: [String: Any]) -> [String: Any]? {
        propertyListValue(dictionary) as? [String: Any]
    }

    private static func propertyListValue(_ value: Any) -> Any? {
        switch value {
        case is NSNull:
            return nil
        case let value as String:
            return value
        case let value as NSNumber:
            return value
        case let value as Date:
            return value
        case let value as Data:
            return value
        case let value as [Any]:
            return value.compactMap(propertyListValue)
        case let value as [String: Any]:
            var result: [String: Any] = [:]
            for (key, nestedValue) in value {
                if let safeValue = propertyListValue(nestedValue) {
                    result[key] = safeValue
                }
            }
            return result
        default:
            return nil
        }
    }
}

extension WatchSessionCoordinator: WCSessionDelegate {
    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        guard activationState == .activated, error == nil else { return }
        stateQueue.async {
            guard let snapshot = self.latestSnapshot else { return }
            try? self.deliver(snapshot: snapshot)
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        receiveCommand(message)
    }

    func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        if message["kind"] as? String == "requestSnapshot" {
            stateQueue.async {
                if let snapshot = self.latestSnapshot {
                    replyHandler([
                        "kind": "sessionSnapshot",
                        "schema": 1,
                        "snapshot": snapshot,
                        "sentAt": Date().timeIntervalSince1970 * 1_000
                    ])
                } else {
                    replyHandler([
                        "kind": "sessionCleared",
                        "schema": 1,
                        "sentAt": Date().timeIntervalSince1970 * 1_000
                    ])
                }
            }
            return
        }

        receiveCommand(message)
        replyHandler([
            "accepted": true,
            "commandId": message["commandId"] as? String ?? ""
        ])
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        receiveCommand(userInfo)
    }
}

enum WatchSessionError: LocalizedError {
    case unsupported
    case invalidPayload

    var errorDescription: String? {
        switch self {
        case .unsupported:
            return "Watch Connectivity is not supported on this device."
        case .invalidPayload:
            return "The Watch session payload is invalid."
        }
    }
}
