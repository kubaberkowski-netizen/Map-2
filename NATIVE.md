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

The native bundle includes the official `@capacitor/app` and
`@capacitor/haptics` plugins. `App` handles `flaneur://walk` opens from the iOS
Live Activity, Android/system back behavior, and app minimization. The shared
haptic helper uses `Haptics` when that plugin is available and keeps a browser
fallback for the website/PWA. Keep these dependencies synchronized with
`npx cap sync`; neither plugin replaces the custom `NativeWalkRecorder` bridge.

The `native:add:ios` and `native:add:android` scripts are retained only for
recreating a deleted platform project. Do not run them over an existing native
project.

### Map runtime and offline boundary

Leaflet, Leaflet MarkerCluster, their CSS, images, and licences are vendored in
`vendor/` and copied into `native-web/`. Opening the map therefore does not
depend on loading the Leaflet runtime from a CDN. The raster map tiles are still
network resources (MapTiler with a Carto fallback); they are not packaged as an
offline region. Previously requested tiles may be served from the PWA service
worker cache or a platform HTTP cache, but that is opportunistic. A new area or
an evicted cache still needs a connection, and the Capacitor bundle deliberately
does not register the PWA service worker.

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

type NativeElapsed =
  | { elapsedMs: number; elapsedSeconds?: never } // Android
  | { elapsedSeconds: number; elapsedMs?: never }; // iOS

type NativeWalkState = {
  sessionId: string;
  status: "recording" | "paused" | "stopped";
  startedAt: number;
  distanceMeters: number;
  pausedMs: number;
};

type NativeWalkSnapshot = NativeWalkState & NativeElapsed & {
  points: NativeWalkPoint[];
};

type NativeWalkUpdate = NativeWalkState & NativeElapsed & {
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
  }): Promise<NativeWalkUpdate | void>;
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

Elapsed time comes from the native recorder, not from the timestamps of the
accepted route points. Android emits `elapsedMs` as an integer number of active
milliseconds; iOS emits integer `elapsedSeconds`. The web bridge accepts those
two platform shapes (and the legacy `elapsedMilliseconds` alias), normalizes
them to milliseconds, persists that value in the active-walk draft, and uses it
when saving the finished walk. A legitimate zero is not treated as missing.

The shared shell hands native up to 2,000 `radarCandidates` plus the planned
`routeStops`. For cities larger than that pool, it chooses candidates around the
current position and planned corridor, then orders the handoff deterministically
so unchanged context is not resent. The native recorders de-duplicate the
context and compute proximity while the WebView is suspended. Only the nearest
three in-range targets are rendered on a Lock Screen surface; this is a display
limit, not a 3-place search limit. iOS defensively caps each input array at
2,000, while Android has a 2,500 combined-context guard so the 2,000-place pool
and ordinary route stops fit.

All three recorders share the core hygiene rules: precise fixes no worse than
65 metres, movement of at least `max(12 m, accuracy / 2)`, bounded fix
timestamps, route segmentation after long/implausible gaps, and retention of
the most recent 6,000 accepted points. Their motion policies are deliberately
platform-specific and are not expected to produce byte-for-byte identical
routes:

- iOS buffers movement at the running/vehicle boundary. A short fast burst is
  replayed through the normal point filter so runners are retained; sustained
  movement at 6 m/s or more for 20 seconds enters vehicle mode. It resumes only
  after 10 seconds at 4.5 m/s or less and starts a new segment.
- Android combines platform-reported and derived speed in a pre-persistence
  motion gate. Fixes from 5.8–12 m/s remain only in memory: a short burst is
  replayed when pedestrian pace returns, while three consecutive fast segments
  spanning at least 10 seconds enter vehicle mode and are discarded. An
  implausible fix over 12 m/s never becomes the next motion reference. Vehicle
  mode exits only after 10 seconds at 4.5 m/s or less and recovery starts a new
  route segment.
- The browser fallback has a simpler Web Geolocation speed guard and creates a
  new segment when pedestrian-speed recording recovers. It is a safety net, not
  an exact model of either native filter.

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

Place names, radar geometry, distance, and elapsed values are marked privacy
sensitive. When iOS applies privacy redaction, the Live Activity replaces them
with generic walk state rather than exposing nearby-place detail. On iOS 16.2+
recording content receives a three-minute stale date; a stale activity replaces
the radar with a reconnect prompt until the recorder refreshes it. Paused state
has no running stale deadline.

The whole Live Activity is a tap-to-open surface using `flaneur://walk`; it opens
Flâneur directly to the active walk. This implementation does **not** provide
true no-launch Pause or End buttons on iOS. Those controls would require a
separate iOS 17+ App Intent/shared-container design and must not be claimed for
the current minimum-iOS-15 target.

Standard background updates are not a promise to outlive an explicit app force
quit. Points already committed remain recoverable. A recording recovered after
more than two minutes without a native update is restored paused so downtime is
not counted as walking time.

### Apple Watch companion

The `Flâneur Watch` target is a phone-connected watchOS 10 companion. Walks are
still created and saved by the iPhone; the Watch is the glanceable in-walk
surface. It shows elapsed time, distance, the next stop, and a compass-oriented
radar with 150, 300, and 600 metre Digital Crown ranges. A fresh iPhone fix is
preferred, with Watch GPS and heading used when the phone location becomes
stale.

The iPhone retains the latest bounded session snapshot through Watch
Connectivity application context. Pause, Resume, and End are validated against
the session ID, executed by the native iPhone recorder even when the WebView is
suspended, explicitly acknowledged, and reconciled into the shared web state.
Check-in remains phone-authoritative because it needs the current visit,
distance, and cooldown rules. Controls require a reachable iPhone; a cached
radar can remain visible while disconnected.

The companion bundle identifier is
`com.kubaberkowski.flaneur.watchkitapp`, paired with
`com.kubaberkowski.flaneur`. Device/TestFlight signing must cover the iPhone
app, Live Activity widget, and Watch app.

### Android

The recorder is a user-started location foreground service. Its private,
ongoing notification is the Android lock-screen surface: elapsed time, distance,
nearest target plus cardinal direction, and Pause/Resume and End actions. A
redacted public version hides place and route detail when the device chooses a
public lock-screen presentation.

Pause/Resume and End are service actions that can run without opening the
WebView. Every `PendingIntent` carries the originating session ID, uses a
session-specific identity, and is rejected unless it still matches the active
session. A delayed action from an old notification therefore cannot mutate a
new walk. The notification's periodic heartbeat/ticker runs only while recording
and stops while paused.

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

### Privacy and signed-device release checks

Recorded points remain in the app's private local database/file. Android app
backup and device-transfer extraction are disabled because the native database
is mirrored into WebView/Preferences state during crash-safe handoff; iOS marks
its recorder file as excluded from backup. Nearby place names can reveal where
someone is walking, so the Android notification provides a redacted public
version and both platforms defer to OS lock-screen privacy settings. Android's
Pause/Resume and End notification actions are intentionally available without
unlocking; someone holding the locked phone can alter the session, but the
public notification does not reveal the route or nearby place.

Simulator builds and browser-native previews are useful for layout, JavaScript,
and bridge-contract checks, but they cannot sign off background GPS, Lock Screen
presentation, process lifecycle, or battery behavior. Before a store release,
record the app version/commit, signing identity, OS build, device model, and
starting/ending battery percentage, then complete this checklist on signed
physical-device builds:

- [ ] On both platforms, start with Precise Location, walk for 30–60 minutes
  with the phone locked and the WebView backgrounded, then compare the restored
  route, active elapsed time, pauses, distance, and segments with the real run.
- [ ] Lock before and after the first accepted fix; verify the Lock Screen starts
  in a waiting state, becomes current, marks lost/stale signal honestly, and
  recovers without inventing distance.
- [ ] Pause, leave paused for several minutes, resume, and end. Verify paused
  time is excluded and the stopped session imports exactly once after relaunch.
- [ ] Exercise process eviction separately from an explicit user force-stop.
  Relaunch and verify the committed route recovers safely. On iOS, explicitly
  force-quitting is allowed to stop future Core Location delivery and must not
  be represented as guaranteed background recording.
- [ ] Repeat with Low Power Mode/battery saver and, on Android, Doze plus the
  major OEM battery-optimization modes in the supported device matrix. Capture
  battery drain and logs; do not infer endurance from a simulator.
- [ ] Deny location, grant approximate-only access, grant Precise Location,
  revoke it mid-walk, and disable system Location Services. Confirm recording
  refuses or pauses with actionable copy and preserves already committed data.
- [ ] Deny and later grant Android 13+ notification permission. Confirm the
  foreground service behavior and app disclosure remain accurate even when the
  Lock Screen card is suppressed by the OS.
- [ ] On iOS 16.1+, verify the signed widget extension, Live Activity and Dynamic
  Island where available, privacy-redacted presentation, three-minute stale
  state, and `flaneur://walk` tap-to-open. Confirm there are no advertised
  no-launch Pause/End controls.
- [ ] On a paired physical Apple Watch, verify live radar freshness, Digital
  Crown range changes, phone-disconnected fallback, and acknowledged
  Pause/Resume, End, and check-in commands while the iPhone is locked and
  backgrounded.
- [ ] On Android, test the private and public/redacted notification on a locked
  device, Pause/Resume and End without opening the app, and a stale action from
  an earlier session. The stale action must not alter the current walk.
- [ ] Test first launch, background/lock, process recovery, and finished-walk
  acknowledgement with no network. The recorder must remain local; Leaflet can
  load, while uncached map tiles should show the documented offline limitation.

Google Play also requires the location foreground-service declaration and an
accurate prominent disclosure. Device/TestFlight signing must include the iOS
widget extension and embedded Watch app target. Retain device logs for failed
cases and do not mark this list complete from an unsigned or simulator-only
build.

## Release sequence

1. Validate refresh recovery and Tube segmentation in the PWA.
2. Validate the iOS recorder and Live Activity on a signed physical iPhone.
3. Validate the companion on a paired physical Apple Watch, including a locked
   and backgrounded iPhone.
4. Validate the Android foreground service across API 24, 33, 34 and 36.
5. Add final app icons, privacy manifests, signing and store disclosures.
6. Ship TestFlight and Play internal-test builds before public distribution.

The application identifier is currently `com.kubaberkowski.flaneur`. Change it
before the first store release only if a different permanent bundle identifier
is preferred; changing it after release creates a different application.
