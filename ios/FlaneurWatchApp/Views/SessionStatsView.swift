import SwiftUI

struct SessionStatsView: View {
    let snapshot: WatchSessionSnapshot
    let navigation: WatchNavigationContext
    let now: Date

    private var nextMeasurement: WatchTargetMeasurement? {
        guard let origin = navigation.origin, let target = snapshot.nextStop else { return nil }
        let bearing = origin.bearing(to: target)
        return WatchTargetMeasurement(
            target: target,
            distanceMeters: origin.distance(to: target),
            bearingDegrees: bearing,
            relativeBearingDegrees: bearing - navigation.headingDegrees
        )
    }

    var body: some View {
        VStack(spacing: 8) {
            if let next = nextMeasurement {
                VStack(spacing: 2) {
                    Text("NEXT")
                        .font(.system(size: 9, weight: .bold))
                        .tracking(1.1)
                        .foregroundStyle(FlaneurWatchStyle.accent)
                    Text(next.target.name)
                        .font(.headline)
                        .lineLimit(1)
                    Text("\(distance(next.distanceMeters)) · \(next.directionLabel)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
            }

            HStack(spacing: 6) {
                metric(title: "TIME", value: duration(snapshot.elapsed(at: now)))
                metric(title: "DISTANCE", value: distance(snapshot.distanceMeters))
            }
        }
    }

    private func metric(title: String, value: String) -> some View {
        VStack(spacing: 2) {
            Text(title)
                .font(.system(size: 8, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.body, design: .rounded, weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 7)
        .background(FlaneurWatchStyle.panel, in: RoundedRectangle(cornerRadius: 11))
    }

    private func duration(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval.rounded(.down)))
        let hours = seconds / 3_600
        let minutes = (seconds % 3_600) / 60
        let remainingSeconds = seconds % 60
        if hours > 0 {
            return String(format: "%d:%02d", hours, minutes)
        }
        return String(format: "%02d:%02d", minutes, remainingSeconds)
    }

    private func distance(_ meters: Double) -> String {
        if meters >= 1_000 {
            return String(format: "%.1f km", meters / 1_000)
        }
        return "\(Int(max(0, meters).rounded())) m"
    }
}
