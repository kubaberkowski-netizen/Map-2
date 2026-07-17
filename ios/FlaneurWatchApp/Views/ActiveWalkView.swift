import SwiftUI

struct ActiveWalkView: View {
    @ObservedObject var client: WatchSessionClient
    @ObservedObject var locationProvider: WatchLocationProvider
    let snapshot: WatchSessionSnapshot

    @State private var crownValue: Double
    @FocusState private var radarHasFocus: Bool

    private let ranges = [150, 300, 600]

    init(
        client: WatchSessionClient,
        locationProvider: WatchLocationProvider,
        snapshot: WatchSessionSnapshot
    ) {
        self.client = client
        self.locationProvider = locationProvider
        self.snapshot = snapshot
        let range = WatchSessionSnapshot.normalizedRadarRange(snapshot.radarRangeMeters)
        _crownValue = State(initialValue: Double([150, 300, 600].firstIndex(of: range) ?? 1))
    }

    private var rangeMeters: Int {
        ranges[min(2, max(0, Int(crownValue.rounded())))]
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            let navigation = WatchNavigationContext.resolve(
                snapshot: snapshot,
                watchLocation: locationProvider.location,
                watchHeading: locationProvider.heading,
                now: timeline.date
            )
            let nextDistance = nextStopDistance(using: navigation)

            TabView {
                radarPage(navigation: navigation, now: timeline.date)
                controlsPage(
                    navigation: navigation,
                    nextStopDistance: nextDistance,
                    now: timeline.date
                )
            }
            .tabViewStyle(.verticalPage)
        }
        .onChange(of: snapshot.radarRangeMeters) { _, newRange in
            let normalized = WatchSessionSnapshot.normalizedRadarRange(newRange)
            crownValue = Double(ranges.firstIndex(of: normalized) ?? 1)
        }
    }

    private func radarPage(navigation: WatchNavigationContext, now: Date) -> some View {
        VStack(spacing: 3) {
            statusRow(navigation: navigation, now: now)

            ZStack(alignment: .bottom) {
                RadarCanvasView(
                    snapshot: snapshot,
                    navigation: navigation,
                    rangeMeters: rangeMeters
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                Text("\(rangeMeters) m")
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.black.opacity(0.75), in: Capsule())
                    .padding(.bottom, 1)
            }
            .focusable()
            .focused($radarHasFocus)
            .digitalCrownRotation(
                $crownValue,
                from: 0,
                through: 2,
                by: 1,
                sensitivity: .low,
                isContinuous: false,
                isHapticFeedbackEnabled: true
            )
            .onAppear { radarHasFocus = true }

            if let nextStop = snapshot.nextStop {
                Text(nextStop.name)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .foregroundStyle(nextStop.isCheckedIn ? FlaneurWatchStyle.success : .primary)
            } else {
                Text(navigation.origin == nil ? "Waiting for location" : "Explore nearby")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 4)
    }

    private func controlsPage(
        navigation: WatchNavigationContext,
        nextStopDistance: Double?,
        now: Date
    ) -> some View {
        ScrollView {
            VStack(spacing: 9) {
                SessionStatsView(snapshot: snapshot, navigation: navigation, now: now)

                if let error = client.commandError {
                    Button { client.clearCommandError() } label: {
                        Label(error, systemImage: "exclamationmark.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.plain)
                }

                SessionControlsView(
                    client: client,
                    snapshot: snapshot,
                    nextStopDistance: nextStopDistance,
                    locationAccuracy: navigation.origin?.accuracy
                )

                if !client.connectionState.isReachable {
                    Text("Controls need the iPhone app open. Radar can continue with Watch GPS.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, 5)
        }
    }

    private func statusRow(navigation: WatchNavigationContext, now: Date) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(snapshot.state == .paused ? Color.orange : FlaneurWatchStyle.accent)
                .frame(width: 6, height: 6)
            Text(snapshot.state == .paused ? "Paused" : "Walking")
                .font(.system(size: 10, weight: .bold))
            Spacer(minLength: 2)
            if !client.connectionState.isReachable {
                Label("Offline", systemImage: "iphone.slash")
                    .foregroundStyle(.orange)
            } else if snapshot.isStale(at: now) {
                Label("Delayed", systemImage: "clock.arrow.circlepath")
                    .foregroundStyle(.orange)
            } else if navigation.locationSource == .watch {
                Label("Watch GPS", systemImage: "location.fill")
                    .foregroundStyle(FlaneurWatchStyle.success)
            }
        }
        .font(.system(size: 9, weight: .semibold))
        .lineLimit(1)
    }

    private func nextStopDistance(using navigation: WatchNavigationContext) -> Double? {
        guard let origin = navigation.origin, let nextStop = snapshot.nextStop else { return nil }
        return origin.distance(to: nextStop)
    }
}
