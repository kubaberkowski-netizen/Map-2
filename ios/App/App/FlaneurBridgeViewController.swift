import Capacitor

@objc(FlaneurBridgeViewController)
final class FlaneurBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(NativeWalkRecorderPlugin())
        bridge?.registerPluginInstance(WatchSessionBridgePlugin())
    }
}
