import Foundation

enum WatchLocationSource: String, Sendable {
    case phone = "iPhone GPS"
    case watch = "Watch GPS"
    case unavailable = "No GPS"
}

struct WatchNavigationContext: Equatable, Sendable {
    let origin: WatchCoordinate?
    let headingDegrees: Double
    let hasHeading: Bool
    let locationSource: WatchLocationSource

    static func resolve(
        snapshot: WatchSessionSnapshot,
        watchLocation: WatchDeviceLocation?,
        watchHeading: WatchHeadingSample?,
        now: Date
    ) -> WatchNavigationContext {
        let nowMilliseconds = now.timeIntervalSince1970 * 1_000
        let phoneTimestamp = snapshot.currentLocation?.timestamp ?? snapshot.updatedAt
        let phoneIsFresh = snapshot.currentLocation?.isValid == true
            && nowMilliseconds - phoneTimestamp < 15_000
        let watchTimestamp = watchLocation?.coordinate.timestamp ?? 0
        let watchIsFresh = watchLocation?.coordinate.isValid == true
            && nowMilliseconds - watchTimestamp < 30_000

        let origin: WatchCoordinate?
        let source: WatchLocationSource
        if phoneIsFresh {
            origin = snapshot.currentLocation
            source = .phone
        } else if watchIsFresh {
            origin = watchLocation?.coordinate
            source = .watch
        } else if snapshot.currentLocation?.isValid == true {
            origin = snapshot.currentLocation
            source = .phone
        } else {
            origin = watchLocation?.coordinate
            source = watchLocation == nil ? .unavailable : .watch
        }

        let headingIsFresh = watchHeading.map { nowMilliseconds - $0.timestamp < 10_000 } ?? false
        if let watchHeading, headingIsFresh {
            return WatchNavigationContext(
                origin: origin,
                headingDegrees: watchHeading.degrees.normalizedDegrees,
                hasHeading: true,
                locationSource: source
            )
        }
        if let watchLocation, watchLocation.speed >= 0.8, watchLocation.course >= 0 {
            return WatchNavigationContext(
                origin: origin,
                headingDegrees: watchLocation.course.normalizedDegrees,
                hasHeading: true,
                locationSource: source
            )
        }
        return WatchNavigationContext(
            origin: origin,
            headingDegrees: 0,
            hasHeading: false,
            locationSource: source
        )
    }
}

struct WatchTargetMeasurement: Identifiable, Sendable {
    let target: WatchRadarTarget
    let distanceMeters: Double
    let bearingDegrees: Double
    let relativeBearingDegrees: Double

    var id: String { target.id }

    var directionLabel: String {
        let angle = relativeBearingDegrees.normalizedDegrees
        switch angle {
        case 337.5...360, 0..<22.5: return "ahead"
        case 22.5..<67.5: return "ahead right"
        case 67.5..<112.5: return "right"
        case 112.5..<157.5: return "behind right"
        case 157.5..<202.5: return "behind"
        case 202.5..<247.5: return "behind left"
        case 247.5..<292.5: return "left"
        default: return "ahead left"
        }
    }
}

extension WatchCoordinate {
    var isValid: Bool {
        latitude.isFinite && longitude.isFinite
            && (-90...90).contains(latitude)
            && (-180...180).contains(longitude)
    }

    func distance(to target: WatchRadarTarget) -> Double {
        let earthRadius = 6_371_000.0
        let latitudeDelta = (target.latitude - latitude).radians
        let longitudeDelta = (target.longitude - longitude).radians
        let startLatitude = latitude.radians
        let endLatitude = target.latitude.radians
        let value = sin(latitudeDelta / 2) * sin(latitudeDelta / 2)
            + cos(startLatitude) * cos(endLatitude)
            * sin(longitudeDelta / 2) * sin(longitudeDelta / 2)
        return earthRadius * 2 * atan2(sqrt(value), sqrt(max(0, 1 - value)))
    }

    func bearing(to target: WatchRadarTarget) -> Double {
        let startLatitude = latitude.radians
        let endLatitude = target.latitude.radians
        let longitudeDelta = (target.longitude - longitude).radians
        let y = sin(longitudeDelta) * cos(endLatitude)
        let x = cos(startLatitude) * sin(endLatitude)
            - sin(startLatitude) * cos(endLatitude) * cos(longitudeDelta)
        return atan2(y, x).degrees.normalizedDegrees
    }
}

extension Double {
    fileprivate var radians: Double { self * .pi / 180 }
    fileprivate var degrees: Double { self * 180 / .pi }
    var normalizedDegrees: Double {
        let value = truncatingRemainder(dividingBy: 360)
        return value >= 0 ? value : value + 360
    }
}
