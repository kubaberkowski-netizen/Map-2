import SwiftUI

struct WatchRootView: View {
    @ObservedObject var client: WatchSessionClient
    @ObservedObject var locationProvider: WatchLocationProvider

    private var activeSessionID: String? {
        guard let snapshot = client.snapshot,
              snapshot.state != .idle,
              snapshot.state != .ended else { return nil }
        return snapshot.sessionId
    }

    var body: some View {
        Group {
            if let snapshot = client.snapshot,
               snapshot.state != .idle,
               snapshot.state != .ended {
                ActiveWalkView(
                    client: client,
                    locationProvider: locationProvider,
                    snapshot: snapshot
                )
            } else {
                emptyState
            }
        }
        .onAppear {
            if activeSessionID != nil { locationProvider.start() }
        }
        .onChange(of: activeSessionID) { _, sessionId in
            if sessionId == nil {
                locationProvider.stop()
            } else {
                locationProvider.start()
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            if client.connectionState == .activating {
                ProgressView()
                Text("Connecting to iPhone…")
                    .font(.caption)
            } else {
                Image(systemName: emptyStateSymbol)
                    .font(.system(size: 30))
                    .foregroundStyle(FlaneurWatchStyle.accent)
                Text("No active walk")
                    .font(.headline)
                Text(emptyStateMessage)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                if client.connectionState.isReachable {
                    Button("Refresh") { client.requestLatestSnapshot() }
                        .buttonStyle(.bordered)
                }
            }
        }
        .padding(.horizontal, 10)
    }

    private var emptyStateSymbol: String {
        switch client.connectionState {
        case .unsupported, .unavailable: return "exclamationmark.icloud"
        case .backgroundOnly: return "iphone.slash"
        case .activating, .reachable: return "figure.walk"
        }
    }

    private var emptyStateMessage: String {
        switch client.connectionState {
        case .unsupported:
            return "This Apple Watch cannot connect to the companion app."
        case .unavailable(let message):
            return message
        case .backgroundOnly:
            return "Start a walk in Flâneur on iPhone. Open the phone app to use controls."
        case .activating:
            return "Looking for your paired iPhone."
        case .reachable:
            return "Start tracking a walk in Flâneur on your iPhone."
        }
    }
}
