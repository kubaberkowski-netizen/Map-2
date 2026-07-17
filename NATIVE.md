# Flâneur native application

Flâneur uses one product codebase for three delivery targets:

- the existing GitHub Pages website;
- the installable Progressive Web App;
- native iOS and Android shells built with Capacitor.

The web experience remains the source of truth. Native projects embed the output
of `npm run native:bundle`, so product changes continue to be made once and then
synced into both platforms.

## Native interaction shell

Capacitor builds activate a native-only application shell before the shared UI
starts. The website and PWA keep their existing document layout; the iOS and
Android apps instead lock the document to the device viewport and use safe-area
aware, fixed navigation.

- Discover opens as a full-bleed map with floating location, mode, and map
  controls.
- Walk is a no-scroll action hub. Build, Curated, and Record open dedicated
  child screens whose content scrolls inside the available viewport when
  necessary.
- Play opens with a featured experience and leaderboard. The complete game
  cabinet is a paged child screen rather than a long catalogue.
- You is a compact dashboard of large destinations. Profile subsections open as
  bounded child screens.
- Primary interactive controls have a minimum 44px touch target.

For local browser QA, build the app, serve the repository, and append
`?native=1` to `index.html`. This preview uses the same shell marker injected by
`tools/build-native.js`; it is intended for layout testing and does not emulate
native device APIs.

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

Browsers retain the shared `navigator.geolocation` recorder. Inside the native
shells, `NativeWalkRecorder` becomes the single source of recorded points as
soon as a user taps Start. The browser watch can still refresh the unlocked
map's current-position dot, but it never appends a second copy of native points.

Native sessions are written incrementally to private device storage and survive
a suspended WebView. The shared UI asks for a snapshot on launch and whenever
the app returns to the foreground. Stopping is deliberately two-phase: native
keeps the stopped snapshot until a read-after-write check confirms that
`flaneur-walks` was saved, then the web layer calls `acknowledge`. This closes
the crash window between stopping GPS and saving the finished walk. During an
active session, bridge events contain only the latest point and summary; a full
point history is pulled on foregrounding or stopping so long walks do not
repeatedly serialize the entire route.

The bridge contract is:

```ts
type NativeWalkPoint = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: number;
  startsNewSegment: boolean;
};

type NativeRadarItem = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  category?: string;
  emoji?: string;
  ordinal?: number;
  isRouteStop?: boolean;
  isCompleted?: boolean;
};

type NativeWalkSnapshot = {
  sessionId: string;
  status: "recording" | "paused" | "stopped";
  startedAt: number;
  distanceMeters: number;
  pausedMs: number;
  points: NativeWalkPoint[];
};

type NativeWalkUpdate = Omit<NativeWalkSnapshot, "points"> & {
  points?: NativeWalkPoint[];
  latestPoint?: NativeWalkPoint;
};

interface NativeWalkRecorder {
  checkPermissions(): Promise<Record<string, string>>;
  requestPermissions(): Promise<Record<string, string>>;
  start(options: {
    sessionId: string;
    startedAt: number;
    routeStops: NativeRadarItem[];
    radarCandidates: NativeRadarItem[];
    rangeM: number;
    lockScreenEnabled: boolean;
  }): Promise<NativeWalkSnapshot>;
  pause(options?: { sessionId?: string }): Promise<NativeWalkSnapshot>;
  resume(options?: { sessionId?: string }): Promise<NativeWalkSnapshot>;
  updateContext(options: {
    sessionId: string;
    routeStops: NativeRadarItem[];
    radarCandidates: NativeRadarItem[];
    rangeM: number;
    lockScreenEnabled: boolean;
  }): Promise<NativeWalkSnapshot | void>;
  snapshot(options?: { sessionId?: string }): Promise<NativeWalkSnapshot | null>;
  stop(options?: { sessionId?: string }): Promise<NativeWalkSnapshot>;
  acknowledge(options: { sessionId: string }): Promise<void>;
  discard(options: { sessionId?: string }): Promise<void>;
  addListener(
    "walkUpdate",
    listener: (snapshot: NativeWalkUpdate) => void,
  ): Promise<{ remove(): void }>;
}
```

Both implementations mirror the browser acceptance rules: accuracy no worse
than 65 metres, movement of at least `max(12 m, accuracy / 2)`, calculated speed
no faster than 12 m/s, and a new route segment after a long or implausible GPS
gap. The most recent 6,000 accepted points are retained.
Recording requires precise location on both native platforms; approximate-only
access is rejected with an actionable message instead of silently producing an
empty route.

### iOS

The recorder uses Core Location's standard updates with the `location`
background mode, fitness activity type, best accuracy, a short distance filter,
automatic pausing disabled, and the visible background-location indicator. A
walk must begin while the app is in front. Flâneur requests When In Use access;
it does not request Always access for this user-started session model. The first
accepted fix is checkpointed immediately; later route checkpoints are bounded
by 30 seconds, 100 metres or 25 accepted points, while lifecycle actions force
an immediate write.

On iOS 16.1 and later, an ActivityKit widget renders a compact north-up radar on
the Lock Screen and Dynamic Island. It shows a small bounded set of native
blips, the nearest target and direction, elapsed time, and recorded distance.
The widget never runs location or network requests itself; the containing app's
recorder supplies throttled state updates. iOS 15 continues background
recording without the Live Activity.

Standard background updates are not a promise to outlive an explicit app force
quit. Points already committed remain recoverable. A recording recovered after
more than two minutes without a native update is restored paused so downtime is
not counted as walking time.

### Android

The recorder is a user-started location foreground service. Its private,
ongoing notification is the Android lock-screen surface: elapsed time, distance,
nearest target plus cardinal direction, and Pause/Resume and End actions. A
redacted public version hides place and route detail when the device chooses a
public lock-screen presentation.

The app requests foreground location and, on Android 13+, notification access.
It intentionally does not request `ACCESS_BACKGROUND_LOCATION`: the recording
session begins from the visible Start button and remains represented by the
foreground service. If notification permission is denied, Android may suppress
the lock-screen card even though the foreground-service session itself can
continue. If the service is no longer alive after a process restart, the next
visible snapshot either restarts it safely or restores the session paused. A
15-second persisted heartbeat trims long, stale process-death gaps from walking
time, and every notification action is bound to its originating
session so an old Lock Screen card cannot pause or end a newer walk. Losing
Precise Location or disabling Location Services pauses the recording instead of
leaving stale state running.

### Privacy and release checks

Recorded points remain in the app's private local database/file. Android app
backup and device-transfer extraction are disabled because the native database
is mirrored into WebView/Preferences state during crash-safe handoff; iOS marks
its recorder file as excluded from backup. Nearby place names can reveal where
someone is walking, so the Android notification provides a redacted public
version and both platforms defer to OS lock-screen privacy settings. Android's
Pause/Resume and End notification actions are intentionally available without
unlocking; someone holding the locked phone can alter the session, but the
public notification does not reveal the route or nearby place.

Before a store release, validate on physical devices: 30–60 minutes locked,
the iOS Live Activity radar, Android Lock Screen Pause/Resume and End, process
eviction, low-power/battery saver, approximate-location rejection, permission
denial/revocation, and relaunch import.
Google Play also requires the location foreground-service declaration and an
accurate prominent disclosure. Device/TestFlight signing must include the iOS
widget extension.

## Release sequence

1. Validate refresh recovery and Tube segmentation in the PWA.
2. Validate the iOS recorder and Live Activity on a signed physical iPhone.
3. Validate the Android foreground service across API 24, 33, 34 and 36.
4. Add final app icons, privacy manifests, signing and store disclosures.
5. Ship TestFlight and Play internal-test builds before public distribution.

The application identifier is currently `com.kubaberkowski.flaneur`. Change it
before the first store release only if a different permanent bundle identifier
is preferred; changing it after release creates a different application.
