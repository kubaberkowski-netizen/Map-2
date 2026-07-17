import Foundation
import SwiftUI
@preconcurrency import CoreLocation

struct WatchDeviceLocation: Equatable, Sendable {
    let coordinate: WatchCoordinate
    let speed: Double
    let course: Double
}

struct WatchHeadingSample: Equatable, Sendable {
    let degrees: Double
    let accuracy: Double
    let timestamp: Double
}

@MainActor
final class WatchLocationProvider: NSObject, ObservableObject {
    @Published private(set) var location: WatchDeviceLocation?
    @Published private(set) var heading: WatchHeadingSample?
    @Published private(set) var authorizationStatus: CLAuthorizationStatus
    @Published private(set) var locationError: String?

    private let manager: CLLocationManager
    private var isRunning = false

    override init() {
        manager = CLLocationManager()
        authorizationStatus = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 5
        manager.headingFilter = 3
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            startUpdates()
        case .denied, .restricted:
            locationError = "Location is off for Flâneur on Apple Watch."
        @unknown default:
            locationError = "Location is unavailable."
        }
    }

    func stop() {
        isRunning = false
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
    }

    private func startUpdates() {
        guard isRunning else { return }
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            manager.startUpdatingHeading()
        }
    }
}

extension WatchLocationProvider: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.authorizationStatus = status
            switch status {
            case .authorizedAlways, .authorizedWhenInUse:
                self.locationError = nil
                self.startUpdates()
            case .denied, .restricted:
                self.locationError = "Location is off for Flâneur on Apple Watch."
            case .notDetermined:
                break
            @unknown default:
                self.locationError = "Location is unavailable."
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let value = locations.last, value.horizontalAccuracy >= 0 else { return }
        let reading = WatchDeviceLocation(
            coordinate: WatchCoordinate(
                latitude: value.coordinate.latitude,
                longitude: value.coordinate.longitude,
                accuracy: value.horizontalAccuracy,
                timestamp: value.timestamp.timeIntervalSince1970 * 1_000
            ),
            speed: value.speed,
            course: value.course
        )
        Task { @MainActor [weak self] in
            self?.location = reading
            self?.locationError = nil
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        guard newHeading.headingAccuracy >= 0 else { return }
        let degrees = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
        let reading = WatchHeadingSample(
            degrees: degrees,
            accuracy: newHeading.headingAccuracy,
            timestamp: newHeading.timestamp.timeIntervalSince1970 * 1_000
        )
        Task { @MainActor [weak self] in self?.heading = reading }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        let nsError = error as NSError
        guard nsError.domain != kCLErrorDomain || nsError.code != CLError.locationUnknown.rawValue else {
            return
        }
        Task { @MainActor [weak self] in self?.locationError = error.localizedDescription }
    }
}
