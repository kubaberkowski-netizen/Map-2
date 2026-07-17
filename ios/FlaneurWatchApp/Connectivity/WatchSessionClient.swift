import Foundation
import SwiftUI
@preconcurrency import WatchConnectivity

enum PhoneConnectionState: Equatable, Sendable {
    case unsupported
    case activating
    case reachable
    case backgroundOnly
    case unavailable(String)

    var isReachable: Bool { self == .reachable }
}

@MainActor
final class WatchSessionClient: NSObject, ObservableObject {
    @Published private(set) var snapshot: WatchSessionSnapshot?
    @Published private(set) var connectionState: PhoneConnectionState = .activating
    @Published private(set) var pendingCommand: PendingWatchCommand?
    @Published private(set) var commandError: String?

    private let session: WCSession?
    private var commandTimeoutTask: Task<Void, Never>?

    override init() {
        session = WCSession.isSupported() ? WCSession.default : nil
        super.init()
        guard let session else {
            connectionState = .unsupported
            return
        }
        session.delegate = self
        session.activate()
    }

    var canSendCommand: Bool {
        connectionState.isReachable && pendingCommand == nil
    }

    func requestLatestSnapshot() {
        guard let session, session.isReachable else { return }
        session.sendMessage([
            "kind": "requestSnapshot",
            "schema": WatchSessionSnapshot.currentSchema
        ]) { [weak self] reply in
            let decoded = WatchWireCodec.snapshot(from: reply)
            Task { @MainActor in
                guard let self, let decoded else { return }
                self.apply(snapshot: decoded)
            }
        } errorHandler: { [weak self] _ in
            Task { @MainActor in self?.connectionState = .backgroundOnly }
        }
    }

    func send(_ command: WatchCommandKind, spotId: String? = nil) {
        guard pendingCommand == nil else { return }
        guard let snapshot else {
            commandError = "No active walk on iPhone."
            return
        }
        guard let session, session.isReachable else {
            commandError = "Open Flâneur on your iPhone to use controls."
            connectionState = .backgroundOnly
            return
        }

        let commandId = UUID().uuidString.lowercased()
        let request = WatchCommandRequest(
            commandId: commandId,
            command: command,
            sessionId: snapshot.sessionId,
            spotId: spotId
        )
        pendingCommand = PendingWatchCommand(
            id: commandId,
            command: command,
            spotId: spotId,
            sentAt: Date()
        )
        commandError = nil
        startTimeout(for: commandId)

        session.sendMessage(WatchWireCodec.commandDictionary(for: request)) { [weak self] reply in
            let acknowledgement = WatchWireCodec.acknowledgement(from: reply)
            let replySnapshot = WatchWireCodec.snapshot(from: reply)
            Task { @MainActor in
                guard let self else { return }
                if let acknowledgement {
                    self.apply(acknowledgement: acknowledgement)
                } else if let replySnapshot {
                    self.apply(snapshot: replySnapshot)
                }
            }
        } errorHandler: { [weak self] error in
            Task { @MainActor in
                self?.failCommand(commandId: commandId, message: error.localizedDescription)
            }
        }
    }

    func clearCommandError() {
        commandError = nil
    }

    private func apply(snapshot: WatchSessionSnapshot) {
        guard snapshot.schema == WatchSessionSnapshot.currentSchema else {
            commandError = "Update Flâneur on iPhone and Apple Watch."
            return
        }
        self.snapshot = snapshot
    }

    private func apply(acknowledgement: WatchCommandAcknowledgement) {
        guard let pendingCommand, pendingCommand.id == acknowledgement.commandId else { return }
        commandTimeoutTask?.cancel()
        commandTimeoutTask = nil
        self.pendingCommand = nil

        guard acknowledgement.success else {
            commandError = acknowledgement.error ?? "Your iPhone could not complete that action."
            return
        }
        if let acknowledgedSnapshot = acknowledgement.snapshot {
            apply(snapshot: acknowledgedSnapshot)
        } else if var current = snapshot {
            current.applyAcknowledged(pendingCommand.command, spotId: pendingCommand.spotId)
            snapshot = current
            requestLatestSnapshot()
        }
    }

    private func failCommand(commandId: String, message: String) {
        guard pendingCommand?.id == commandId else { return }
        commandTimeoutTask?.cancel()
        commandTimeoutTask = nil
        pendingCommand = nil
        commandError = message
    }

    private func startTimeout(for commandId: String) {
        commandTimeoutTask?.cancel()
        commandTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard !Task.isCancelled else { return }
            self?.failCommand(
                commandId: commandId,
                message: "The iPhone did not acknowledge the action."
            )
        }
    }

    private func clearSnapshot() {
        snapshot = nil
        pendingCommand = nil
        commandTimeoutTask?.cancel()
    }
}

extension WatchSessionClient: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: (any Error)?
    ) {
        let initialSnapshot = WatchWireCodec.snapshot(from: session.receivedApplicationContext)
        let reachable = session.isReachable
        let errorMessage = error?.localizedDescription
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let errorMessage {
                self.connectionState = .unavailable(errorMessage)
            } else if activationState == .activated {
                self.connectionState = reachable ? .reachable : .backgroundOnly
            }
            if let initialSnapshot { self.apply(snapshot: initialSnapshot) }
            if reachable { self.requestLatestSnapshot() }
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor [weak self] in
            self?.connectionState = reachable ? .reachable : .backgroundOnly
            if reachable { self?.requestLatestSnapshot() }
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveApplicationContext applicationContext: [String: Any]
    ) {
        let kind = WatchWireCodec.messageKind(in: applicationContext)
        let isClear = kind == "clear" || kind == "sessionCleared"
        let decoded = WatchWireCodec.snapshot(from: applicationContext)
        Task { @MainActor [weak self] in
            guard let self else { return }
            if isClear { self.clearSnapshot() }
            if let decoded { self.apply(snapshot: decoded) }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        receive(message)
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        receive(message)
        replyHandler(["kind": "received", "schema": WatchSessionSnapshot.currentSchema])
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        receive(userInfo)
    }

    nonisolated private func receive(_ message: [String: Any]) {
        let kind = WatchWireCodec.messageKind(in: message)
        let isClear = kind == "clear" || kind == "sessionCleared"
        let acknowledgement = WatchWireCodec.acknowledgement(from: message)
        let decoded = WatchWireCodec.snapshot(from: message)
        Task { @MainActor [weak self] in
            guard let self else { return }
            if isClear { self.clearSnapshot() }
            if let acknowledgement { self.apply(acknowledgement: acknowledgement) }
            if let decoded { self.apply(snapshot: decoded) }
        }
    }
}
