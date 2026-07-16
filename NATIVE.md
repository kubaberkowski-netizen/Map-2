# Flâneur native application

Flâneur uses one product codebase for three delivery targets:

- the existing GitHub Pages website;
- the installable Progressive Web App;
- native iOS and Android shells built with Capacitor.

The web experience remains the source of truth. Native projects embed the output
of `npm run native:bundle`, so product changes continue to be made once and then
synced into both platforms.

## Work with the native projects

The `ios/` Xcode project and `android/` Android Studio project are committed to
the repository. They are native source projects, not disposable build output.

Requirements:

- Node.js 22 or newer;
- Xcode on macOS for iOS;
- Android Studio with JDK 21 for Android.

Install dependencies and synchronize the latest Flâneur web application into
both native projects:

```bash
npm ci
npm run native:sync
```

Open the native IDEs with:

```bash
npm run native:open:ios
npm run native:open:android
```

The `native:add:ios` and `native:add:android` scripts are retained only for
recreating a deleted platform project. Do not run them over an existing native
project.

## Walk-recording architecture

This first native foundation keeps foreground walk recording in the shared web
layer. Active sessions are checkpointed to durable storage, recovered after a
WebView or browser reload, and split into separate route segments after a long
GPS gap or background transition. That protects a walk from a page refresh and
prevents a Tube journey from becoming a false straight walking line.

The native shells already declare foreground location access with user-facing
permission copy. Reliable recording while the screen is locked is a separate
native capability. The next native milestone is a small Capacitor plugin with
this contract:

```ts
type NativeWalkPoint = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: number;
  startsNewSegment: boolean;
};

interface NativeWalkRecorder {
  start(sessionId: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<{ points: NativeWalkPoint[] }>;
  recover(): Promise<{ sessionId: string; points: NativeWalkPoint[] } | null>;
}
```

On iOS, the implementation will use Core Location and the Location Updates
background mode. On Android, it will use a location foreground service with an
ongoing notification. The shared Flâneur UI will consume the same point format
whether the provider is the browser or the native plugin.

## Release sequence

1. Validate refresh recovery and Tube segmentation in the PWA.
2. Run the committed iOS project on a physical iPhone and verify foreground GPS.
3. Add the native background-recorder plugin and incremental permission flow.
4. Add final app icons, privacy manifests, signing, and TestFlight distribution.
5. Validate the Android foreground service and ship an internal Play test.

The application identifier is currently `com.kubaberkowski.flaneur`. Change it
before the first store release only if a different permanent bundle identifier
is preferred; changing it after release creates a different application.
