import SwiftUI

struct SessionControlsView: View {
    @ObservedObject var client: WatchSessionClient
    let snapshot: WatchSessionSnapshot
    let nextStopDistance: Double?
    let locationAccuracy: Double?

    @State private var isConfirmingEnd = false

    private var checkInRadius: Double {
        max(50, min(100, (locationAccuracy ?? 0) * 1.5))
    }

    private var canCheckIn: Bool {
        guard let nextStop = snapshot.nextStop,
              !nextStop.isCheckedIn,
              !nextStop.id.hasPrefix("__"),
              let nextStopDistance else { return false }
        return nextStopDistance <= checkInRadius
    }

    var body: some View {
        VStack(spacing: 8) {
            if let pending = client.pendingCommand {
                HStack(spacing: 7) {
                    ProgressView().controlSize(.small)
                    Text(pending.progressLabel)
                        .font(.caption.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(FlaneurWatchStyle.panel, in: Capsule())
                .accessibilityLabel(pending.progressLabel)
            }

            if canCheckIn, let nextStop = snapshot.nextStop {
                Button {
                    client.send(.checkIn, spotId: nextStop.id)
                } label: {
                    Label("Check in", systemImage: "mappin.and.ellipse")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(FlaneurWatchStyle.success)
                .disabled(!client.canSendCommand)
            }

            HStack(spacing: 8) {
                Button {
                    client.send(snapshot.state == .paused ? .resume : .pause)
                } label: {
                    Image(systemName: snapshot.state == .paused ? "play.fill" : "pause.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(snapshot.state == .paused ? "Resume walk" : "Pause walk")
                .disabled(!client.canSendCommand || snapshot.state == .ending)

                Button(role: .destructive) {
                    isConfirmingEnd = true
                } label: {
                    Image(systemName: "stop.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(FlaneurWatchStyle.accent)
                .accessibilityLabel("End walk")
                .disabled(!client.canSendCommand || snapshot.state == .ending)
            }
        }
        .confirmationDialog(
            "End this walk?",
            isPresented: $isConfirmingEnd,
            titleVisibility: .visible
        ) {
            Button("End Walk", role: .destructive) { client.send(.end) }
            Button("Keep Walking", role: .cancel) {}
        }
    }
}
