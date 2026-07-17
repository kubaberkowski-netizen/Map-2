import SwiftUI

struct RadarCanvasView: View {
    let snapshot: WatchSessionSnapshot
    let navigation: WatchNavigationContext
    let rangeMeters: Int

    private var measurements: [WatchTargetMeasurement] {
        guard let origin = navigation.origin else { return [] }
        return snapshot.radarTargets.map { target in
            let bearing = origin.bearing(to: target)
            return WatchTargetMeasurement(
                target: target,
                distanceMeters: origin.distance(to: target),
                bearingDegrees: bearing,
                relativeBearingDegrees: bearing - navigation.headingDegrees
            )
        }
        .filter { $0.distanceMeters <= Double(rangeMeters) || $0.target.id == snapshot.nextStopId }
        .sorted { left, right in
            if left.target.id == snapshot.nextStopId { return true }
            if right.target.id == snapshot.nextStopId { return false }
            return left.distanceMeters < right.distanceMeters
        }
        .prefix(14)
        .map { $0 }
    }

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radarRadius = max(1, min(size.width, size.height) / 2 - 9)

            for ringIndex in 1...3 {
                let radius = radarRadius * CGFloat(ringIndex) / 3
                let rectangle = CGRect(
                    x: center.x - radius,
                    y: center.y - radius,
                    width: radius * 2,
                    height: radius * 2
                )
                context.stroke(
                    Path(ellipseIn: rectangle),
                    with: .color(FlaneurWatchStyle.warmWhite.opacity(ringIndex == 3 ? 0.32 : 0.16)),
                    style: StrokeStyle(lineWidth: ringIndex == 3 ? 1.2 : 0.7, dash: [2, 3])
                )
            }

            var headingLine = Path()
            headingLine.move(to: CGPoint(x: center.x, y: center.y - radarRadius))
            headingLine.addLine(to: CGPoint(x: center.x, y: center.y + radarRadius))
            context.stroke(headingLine, with: .color(FlaneurWatchStyle.warmWhite.opacity(0.1)))

            for measurement in measurements.reversed() {
                let isNext = measurement.target.id == snapshot.nextStopId
                let fraction = min(0.93, max(0.05, measurement.distanceMeters / Double(rangeMeters)))
                let radius = radarRadius * CGFloat(fraction)
                let angle = measurement.relativeBearingDegrees * .pi / 180
                let point = CGPoint(
                    x: center.x + CGFloat(sin(angle)) * radius,
                    y: center.y - CGFloat(cos(angle)) * radius
                )
                let dotRadius: CGFloat = isNext ? 5.5 : 3.5
                let color = measurement.target.isCheckedIn
                    ? FlaneurWatchStyle.success
                    : (isNext ? FlaneurWatchStyle.accent : FlaneurWatchStyle.warmWhite)

                if isNext {
                    let halo = CGRect(
                        x: point.x - dotRadius - 4,
                        y: point.y - dotRadius - 4,
                        width: (dotRadius + 4) * 2,
                        height: (dotRadius + 4) * 2
                    )
                    context.stroke(Path(ellipseIn: halo), with: .color(color.opacity(0.42)), lineWidth: 2)
                }
                let dot = CGRect(
                    x: point.x - dotRadius,
                    y: point.y - dotRadius,
                    width: dotRadius * 2,
                    height: dotRadius * 2
                )
                context.fill(Path(ellipseIn: dot), with: .color(color))
            }

            let userDot = CGRect(x: center.x - 4, y: center.y - 4, width: 8, height: 8)
            context.fill(Path(ellipseIn: userDot), with: .color(FlaneurWatchStyle.accent))

            var direction = Path()
            direction.move(to: CGPoint(x: center.x, y: center.y - 10))
            direction.addLine(to: CGPoint(x: center.x - 3.5, y: center.y - 3))
            direction.addLine(to: CGPoint(x: center.x + 3.5, y: center.y - 3))
            direction.closeSubpath()
            context.fill(
                direction,
                with: .color(navigation.hasHeading ? FlaneurWatchStyle.accent : FlaneurWatchStyle.muted)
            )

            if !navigation.hasHeading {
                context.draw(
                    Text("N").font(.system(size: 8, weight: .bold)).foregroundColor(FlaneurWatchStyle.muted),
                    at: CGPoint(x: center.x, y: center.y - radarRadius + 7)
                )
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Walking radar")
        .accessibilityValue(accessibilitySummary)
    }

    private var accessibilitySummary: String {
        guard navigation.origin != nil else { return "Waiting for location" }
        guard let next = measurements.first(where: { $0.target.id == snapshot.nextStopId }) else {
            return "\(measurements.count) places within \(rangeMeters) metres"
        }
        return "Next, \(next.target.name), \(Int(next.distanceMeters.rounded())) metres \(next.directionLabel)"
    }
}
