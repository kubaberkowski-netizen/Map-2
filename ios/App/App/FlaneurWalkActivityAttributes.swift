import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct FlaneurWalkActivityAttributes: ActivityAttributes {
    struct RadarBlip: Codable, Hashable {
        let id: String
        let name: String
        let emoji: String
        let bearingDegrees: Double
        let distanceMeters: Double
        let isRouteStop: Bool
    }

    struct ContentState: Codable, Hashable {
        let status: String
        let timerAnchorMilliseconds: Double
        let elapsedSeconds: Int
        let distanceMeters: Double
        let nearestName: String
        let nearestDistanceMeters: Double
        let radarRangeMeters: Double
        let blips: [RadarBlip]
    }

    let sessionId: String
    let title: String
}
