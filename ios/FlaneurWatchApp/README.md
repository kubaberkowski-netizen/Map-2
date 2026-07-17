# Flâneur Watch target integration

These files form the paired, phone-connected watchOS 10 app. The `Flâneur Watch`
target is already wired into `ios/App/App.xcodeproj` and embedded by the iPhone
`App` target.

## Target configuration

- Target/product: **Flâneur Watch** / `FlaneurWatch.app`
- Deployment target: watchOS 10.0
- Bundle identifier: `com.kubaberkowski.flaneur.watchkitapp`
- Companion identifier: `com.kubaberkowski.flaneur`
- Location purpose string is generated from the target build settings.
- The iPhone target embeds the product in **Embed Watch Content**.

Select a development team for all three Apple products before a device build:
`App`, `FlaneurRadarWidget`, and `Flâneur Watch`.

The Watch requests location only after an active paired walk appears. A fresh
iPhone coordinate remains authoritative; after 15 seconds without a fresh phone
point, the radar falls back to Apple Watch location. Heading always comes from
the Watch compass, with movement course and north-up as fallbacks.

## Phone/Watch wire contract

The Watch accepts the canonical snapshot either at the message root or under a
`snapshot` key in a Watch Connectivity application-context/message envelope:

```json
{
  "schema": 1,
  "sessionId": "aw-123",
  "state": "recording",
  "startedAt": 1773910200000,
  "elapsedSeconds": 420,
  "distanceMeters": 880,
  "currentLocation": {
    "latitude": 51.5074,
    "longitude": -0.1278,
    "accuracy": 8,
    "timestamp": 1773910620000
  },
  "routeStops": [],
  "nearbyTargets": [],
  "nextStopId": null,
  "radarRangeMeters": 300,
  "updatedAt": 1773910620000
}
```

Targets use `id`, `name`, `latitude`, `longitude`, optional `category`, and
`isCheckedIn`. For compatibility, the Watch also accepts `isCompleted` or
`isVisited`. Timestamps are epoch milliseconds.

Commands are immediate `sendMessage` dictionaries and are never applied before
acknowledgement:

```json
{
  "kind": "command",
  "schema": 1,
  "commandId": "uuid",
  "command": "pause|resume|end|checkIn",
  "sessionId": "aw-123",
  "spotId": "optional-for-checkIn"
}
```

The phone must later send an explicit acknowledgement, either as a reply or a
separate message/user-info transfer:

```json
{
  "kind": "commandAck",
  "schema": 1,
  "commandId": "same-uuid",
  "success": true,
  "error": null,
  "snapshot": {}
}
```

The phone bridge exposes
`WatchSessionBridge.publish({ snapshot })`, `clear()`,
`acknowledge({ commandId, success, error?, snapshot? })`, and the
`watchCommand` listener. The Watch accepts both `clear` and `sessionCleared`
message kinds.

## Verification

Run `npm run native:sync` before opening Xcode. The Watch Swift sources compile
and link for arm64 and x86_64 watchOS simulator architectures. A full embedded
run still needs an installed watchOS runtime or a signed, paired iPhone and
Apple Watch. Validate reachability transitions, compass behavior, Digital Crown
focus, battery use, check-in rules, and controls while the phone is locked or
backgrounded.
