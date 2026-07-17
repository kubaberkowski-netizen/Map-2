import Capacitor
import Foundation

@objc(WatchSessionBridgePlugin)
public final class WatchSessionBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WatchSessionBridgePlugin"
    public let jsName = "WatchSessionBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "publish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        WatchSessionCoordinator.shared.activate()
        WatchSessionCoordinator.shared.setCommandHandler { [weak self] command in
            self?.notifyListeners("watchCommand", data: command, retainUntilConsumed: true)
        }
    }

    deinit {
        WatchSessionCoordinator.shared.removeCommandHandler()
    }

    @objc public func publish(_ call: CAPPluginCall) {
        guard let snapshot = call.getObject("snapshot") else {
            call.reject("A Watch session snapshot is required.", "WATCH_SNAPSHOT_REQUIRED")
            return
        }
        do {
            try WatchSessionCoordinator.shared.publish(snapshot: snapshot)
            call.resolve(WatchSessionCoordinator.shared.status())
        } catch {
            call.reject(error.localizedDescription, "WATCH_PUBLISH_FAILED", error)
        }
    }

    @objc public func clear(_ call: CAPPluginCall) {
        do {
            try WatchSessionCoordinator.shared.clear()
            call.resolve(WatchSessionCoordinator.shared.status())
        } catch {
            call.reject(error.localizedDescription, "WATCH_CLEAR_FAILED", error)
        }
    }

    @objc public func acknowledge(_ call: CAPPluginCall) {
        guard let commandID = call.getString("commandId"), !commandID.isEmpty else {
            call.reject("A commandId is required.", "WATCH_COMMAND_ID_REQUIRED")
            return
        }
        let success = call.getBool("success") ?? false
        do {
            try WatchSessionCoordinator.shared.acknowledge(
                commandID: commandID,
                success: success,
                error: call.getString("error"),
                snapshot: call.getObject("snapshot")
            )
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, "WATCH_ACK_FAILED", error)
        }
    }

    @objc public func status(_ call: CAPPluginCall) {
        WatchSessionCoordinator.shared.activate()
        call.resolve(WatchSessionCoordinator.shared.status())
    }
}
