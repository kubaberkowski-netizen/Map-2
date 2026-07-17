import SwiftUI

@main
struct FlaneurWatchApp: App {
    @StateObject private var sessionClient = WatchSessionClient()
    @StateObject private var locationProvider = WatchLocationProvider()

    var body: some Scene {
        WindowGroup {
            WatchRootView(
                client: sessionClient,
                locationProvider: locationProvider
            )
            .tint(FlaneurWatchStyle.accent)
        }
    }
}
