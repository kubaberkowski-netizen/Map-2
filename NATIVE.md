# Flâneur native application

Flâneur now uses one product codebase for three delivery targets:

- the existing GitHub Pages website;
- the installable Progressive Web App;
- native iOS and Android shells built with Capacitor.

The web experience remains the source of truth. Native projects embed the output
of `npm run native:bundle`, so product changes continue to be made once and then
synced into both platforms.

## Bootstrap a native platform

Requirements:

- Node.js 20 or newer;
- Xcode on macOS for iOS;
- Android Studio and a supported JDK for Android.

Install dependencies and prepare the shared web payload:

```bash
npm ci
npm run native:bundle
```

Create each platform once:

```bash
npm run native:add:ios
npm run native:add:android
```

Commit the generated `ios/` and `android/` directories. They are native source
projects, not disposable build output. After ordinary Flâneur changes, update
both projects with:

```bash
npm run native:sync
```

Open the native IDEs with:

```bash
npm run native:open:ios
npm run native:open:android
```

## Walk-recording architecture

This first native foundation deliberately keeps walk recording in the shared
web layer. Active sessions are checkpointed to durable storage, recovered after
a WebView or browser reload, and split into separate route segments after a long
GPS gap or background transition. That protects a walk from a page refresh and
prevents a Tube journey from becoming a false straight walking line.

Reliable recording while the screen is locked is a separate native capability.
The next native milestone is a small Capacitor plugin with this contract:

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
background mode. On Android, it will use a foreground location service with an
ongoing notification. The shared Flâneur UI will consume the same point format
whether the provider is the browser or the native plugin.

## Release sequence

1. Validate refresh recovery and Tube segmentation in the PWA.
2. Generate and commit the iOS project; run on a physical iPhone.
3. Add the native background-recorder plugin and permission copy.
4. Add privacy manifests, app icons, signing, and TestFlight distribution.
5. Generate Android, reuse the same plugin contract, and ship an internal test.

The application identifier is currently `com.kubaberkowski.flaneur`. Change it
before the first store release only if a different permanent bundle identifier
is preferred; changing it after release creates a different application.
