import ActivityKit
import SwiftUI
import WidgetKit

@main
struct FlaneurRadarWidgetBundle: WidgetBundle {
    var body: some Widget {
        FlaneurRadarLiveActivity()
    }
}

struct FlaneurRadarLiveActivity: Widget {
    private let brand = Color(red: 0.78, green: 0.22, blue: 0.18)

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: FlaneurWalkActivityAttributes.self) { context in
            PrivacyAwareLockScreenRadarView(state: context.state, isStale: activityIsStale(context))
                .activityBackgroundTint(Color(red: 0.055, green: 0.052, blue: 0.047))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(walkDeepLinkURL)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(
                            activityIsStale(context) ? "Radar stale" : "Walking",
                            systemImage: activityIsStale(context) ? "exclamationmark.triangle.fill" : "figure.walk"
                        )
                            .font(.caption.bold())
                            .foregroundStyle(brand)
                        ElapsedText(state: context.state, isStale: activityIsStale(context))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .privacySensitive()
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(activityIsStale(context) ? "—" : distanceLabel(context.state.distanceMeters))
                            .font(.headline.monospacedDigit())
                            .privacySensitive()
                        Text("distance")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 12) {
                        Group {
                            if activityIsStale(context) {
                                StaleRadarView()
                            } else {
                                RadarPlot(state: context.state)
                                    .privacySensitive()
                            }
                        }
                            .frame(width: 92, height: 92)
                        nearestSummary(context.state, isStale: activityIsStale(context))
                    }
                    .padding(.top, 4)
                }
            } compactLeading: {
                Image(systemName: activityIsStale(context) ? "exclamationmark.triangle.fill" : "location.north.circle.fill")
                    .foregroundStyle(brand)
            } compactTrailing: {
                Text(activityIsStale(context) ? "STALE" : distanceLabel(context.state.distanceMeters))
                    .font(.caption2.monospacedDigit().bold())
                    .privacySensitive()
            } minimal: {
                Image(systemName: activityIsStale(context) ? "exclamationmark.triangle.fill" : "location.north.fill")
                    .foregroundStyle(brand)
            }
            .keylineTint(brand)
            .widgetURL(walkDeepLinkURL)
        }
    }

    @ViewBuilder
    private func nearestSummary(
        _ state: FlaneurWalkActivityAttributes.ContentState,
        isStale: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(isStale ? "Radar needs an update" : (state.nearestName.isEmpty ? "Scanning nearby" : state.nearestName))
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .privacySensitive(!isStale)
            if isStale {
                Label("Open Flâneur to refresh", systemImage: "arrow.clockwise")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if state.nearestDistanceMeters >= 0 {
                Label(distanceLabel(state.nearestDistanceMeters), systemImage: "scope")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .privacySensitive()
            } else {
                Text("Move a little to wake the radar")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct PrivacyAwareLockScreenRadarView: View {
    @Environment(\.redactionReasons) private var redactionReasons

    let state: FlaneurWalkActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        if redactionReasons.contains(.privacy) {
            PrivateWalkStateView(status: state.status, isStale: isStale)
        } else {
            LockScreenRadarView(state: state, isStale: isStale)
        }
    }
}

private struct PrivateWalkStateView: View {
    let status: String
    let isStale: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: isStale ? "location.slash.circle.fill" : "figure.walk.circle.fill")
                .font(.system(size: 34))
                .foregroundStyle(Color(red: 0.92, green: 0.34, blue: 0.27))
            VStack(alignment: .leading, spacing: 4) {
                Text(status == "paused" ? "Walk paused" : "Walk in progress")
                    .font(.headline)
                Text(isStale ? "Open Flâneur to reconnect" : "Details hidden for privacy · Tap to open")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .foregroundStyle(.white)
    }
}

private struct LockScreenRadarView: View {
    let state: FlaneurWalkActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        HStack(spacing: 14) {
            Group {
                if isStale {
                    StaleRadarView()
                } else {
                    RadarPlot(state: state)
                        .privacySensitive()
                }
            }
                .frame(width: 112, height: 112)

            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 5) {
                    Image(systemName: isStale ? "exclamationmark.triangle.fill" : (state.status == "paused" ? "pause.circle.fill" : "figure.walk.circle.fill"))
                        .foregroundStyle(Color(red: 0.92, green: 0.34, blue: 0.27))
                    Text(isStale ? "Radar stale" : (state.status == "paused" ? "Walk paused" : "Recording walk"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }

                Text(isStale ? "Open Flâneur to refresh" : (state.nearestName.isEmpty ? "Finding nearby places…" : state.nearestName))
                    .font(.headline)
                    .lineLimit(2)
                    .privacySensitive(!isStale)

                if !isStale, state.nearestDistanceMeters >= 0 {
                    Text("\(distanceLabel(state.nearestDistanceMeters)) away")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .privacySensitive()
                }

                HStack(spacing: 14) {
                    Label(distanceLabel(state.distanceMeters), systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                    HStack(spacing: 4) {
                        Image(systemName: "timer")
                        ElapsedText(state: state, isStale: isStale)
                    }
                }
                .font(.caption.monospacedDigit().weight(.medium))
                .privacySensitive()

                Label("Tap for walk controls", systemImage: "hand.tap")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .foregroundStyle(.white)
    }
}

private struct ElapsedText: View {
    let state: FlaneurWalkActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        if state.status == "recording", !isStale {
            Text(Date(timeIntervalSince1970: state.timerAnchorMilliseconds / 1_000), style: .timer)
        } else {
            Text(durationLabel(state.elapsedSeconds))
        }
    }
}

private struct RadarPlot: View {
    let state: FlaneurWalkActivityAttributes.ContentState

    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            let outerRadius = max(1, side / 2 - 10)
            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.055))
                ForEach([0.34, 0.67, 1.0], id: \.self) { scale in
                    Circle()
                        .stroke(Color.white.opacity(scale == 1 ? 0.24 : 0.12), lineWidth: 0.8)
                        .frame(width: outerRadius * 2 * scale, height: outerRadius * 2 * scale)
                }
                Path { path in
                    path.move(to: CGPoint(x: side / 2, y: 8))
                    path.addLine(to: CGPoint(x: side / 2, y: side - 8))
                    path.move(to: CGPoint(x: 8, y: side / 2))
                    path.addLine(to: CGPoint(x: side - 8, y: side / 2))
                }
                .stroke(Color.white.opacity(0.09), style: StrokeStyle(lineWidth: 0.7, dash: [2, 3]))

                Text("N")
                    .font(.system(size: max(7, side * 0.075), weight: .bold, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.7))
                    .offset(y: -outerRadius + 3)

                ForEach(Array(state.blips.prefix(3))) { blip in
                    let angle = blip.bearingDegrees * .pi / 180
                    let fraction = min(1, max(0.1, sqrt(blip.distanceMeters / max(1, state.radarRangeMeters))))
                    let radius = outerRadius * fraction
                    Text(blip.emoji)
                        .font(.system(size: blip.isRouteStop ? side * 0.13 : side * 0.105))
                        .padding(blip.isRouteStop ? 2 : 0)
                        .background(blip.isRouteStop ? Color(red: 0.78, green: 0.22, blue: 0.18).opacity(0.9) : .clear)
                        .clipShape(Circle())
                        .offset(x: sin(angle) * radius, y: -cos(angle) * radius)
                        .accessibilityLabel("\(blip.name), \(distanceLabel(blip.distanceMeters))")
                }

                Circle()
                    .fill(Color(red: 0.92, green: 0.34, blue: 0.27))
                    .frame(width: max(7, side * 0.075), height: max(7, side * 0.075))
                    .overlay(Circle().stroke(Color.white.opacity(0.9), lineWidth: 1.5))
            }
            .frame(width: side, height: side)
            .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("North-up nearby places radar")
        }
    }
}

private struct StaleRadarView: View {
    var body: some View {
        ZStack {
            Circle()
                .fill(Color.white.opacity(0.045))
            Circle()
                .stroke(Color.white.opacity(0.22), style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
                .padding(8)
            Image(systemName: "location.slash.fill")
                .font(.title2)
                .foregroundStyle(Color.white.opacity(0.7))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Nearby places radar needs an update")
    }
}

private func activityIsStale(
    _ context: ActivityViewContext<FlaneurWalkActivityAttributes>
) -> Bool {
    if #available(iOS 16.2, *) {
        return context.isStale
    }
    return false
}

private let walkDeepLinkURL = URL(string: "flaneur://walk?source=live-activity")!

private func distanceLabel(_ meters: Double) -> String {
    if meters < 1_000 {
        return "\(Int(max(0, meters).rounded())) m"
    }
    return String(format: "%.1f km", meters / 1_000)
}

private func durationLabel(_ seconds: Int) -> String {
    let hours = max(0, seconds) / 3_600
    let minutes = max(0, seconds) % 3_600 / 60
    let remainder = max(0, seconds) % 60
    return hours > 0
        ? String(format: "%d:%02d:%02d", hours, minutes, remainder)
        : String(format: "%02d:%02d", minutes, remainder)
}

extension FlaneurWalkActivityAttributes.RadarBlip: Identifiable {}
