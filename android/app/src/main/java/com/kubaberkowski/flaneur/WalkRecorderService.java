package com.kubaberkowski.flaneur;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Records an explicitly started walk as a location foreground service. The private ongoing
 * notification is also the Android lock-screen radar; its public version deliberately redacts
 * place names, direction, distance, and timing.
 */
public class WalkRecorderService extends Service implements LocationListener {
    static final String ACTION_START = "com.kubaberkowski.flaneur.walk.START";
    static final String ACTION_PAUSE = "com.kubaberkowski.flaneur.walk.PAUSE";
    static final String ACTION_RESUME = "com.kubaberkowski.flaneur.walk.RESUME";
    static final String ACTION_UPDATE = "com.kubaberkowski.flaneur.walk.UPDATE";
    static final String ACTION_STOP = "com.kubaberkowski.flaneur.walk.STOP";
    private static final String EXTRA_SESSION_ID = "walkSessionId";

    private static final String CHANNEL_ID = "active_walk";
    private static final int NOTIFICATION_ID = 7421;
    private static final long UPDATE_INTERVAL_MS = 4_000L;
    private static final float UPDATE_DISTANCE_METERS = 5f;
    private static final long SERVICE_STALE_AFTER_MS = 120_000L;
    private static final int MAX_CONTEXT_TARGETS = 2_500;
    private static final int MAX_RENDERED_RADAR_TARGETS = 3;
    private static volatile boolean running;

    private final Handler notificationHandler = new Handler(Looper.getMainLooper());
    private final Runnable notificationTicker = new Runnable() {
        @Override
        public void run() {
            String status = store.status();
            if (WalkRecordingStore.STATUS_RECORDING.equals(status)) {
                if (locationPrerequisitesAvailable()) {
                    store.heartbeat();
                } else {
                    pauseForUnavailableLocation();
                    status = store.status();
                }
                refreshNotification();
                if (WalkRecordingStore.STATUS_RECORDING.equals(status)) {
                    notificationHandler.postDelayed(this, 15_000L);
                }
                return;
            }
            if (WalkRecordingStore.STATUS_IDLE.equals(status) || WalkRecordingStore.STATUS_STOPPED.equals(status)) {
                finishService();
            }
        }
    };

    private WalkRecordingStore store;
    private LocationManager locationManager;
    private HandlerThread locationThread;
    private boolean listening;

    static Intent intent(Context context, String action) {
        return intent(context, action, null);
    }

    static Intent intent(Context context, String action, String sessionId) {
        Intent intent = new Intent(context, WalkRecorderService.class).setAction(action);
        if (sessionId != null && !sessionId.isEmpty()) {
            intent.putExtra(EXTRA_SESSION_ID, sessionId);
            intent.setData(
                new Uri.Builder()
                    .scheme("flaneur")
                    .authority("active-walk")
                    .appendPath(sessionId)
                    .appendPath(action)
                    .build()
            );
        }
        return intent;
    }

    static boolean isRunning() {
        return running;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        store = WalkRecordingStore.get(this);
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        locationThread = new HandlerThread("flaneur-walk-location");
        locationThread.start();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        String requestedSessionId = intent == null ? null : intent.getStringExtra(EXTRA_SESSION_ID);
        if (isSessionBoundAction(action) && !store.matchesSession(requestedSessionId)) {
            // A delayed PendingIntent from an older notification must never mutate a newer walk.
            action = null;
        }
        try {
            if (
                intent == null &&
                WalkRecordingStore.STATUS_RECORDING.equals(store.status()) &&
                isHeartbeatStale()
            ) {
                store.pauseStale(null);
                NativeWalkRecorderPlugin.emitWalkUpdate(this, false);
            }
            if (ACTION_STOP.equals(action)) {
                store.stop(requestedSessionId);
                NativeWalkRecorderPlugin.emitWalkUpdate(this, true);
                finishService();
                return START_NOT_STICKY;
            }
            if (ACTION_PAUSE.equals(action)) {
                store.pause(requestedSessionId);
                NativeWalkRecorderPlugin.emitWalkUpdate(this, false);
            } else if (ACTION_RESUME.equals(action)) {
                if (locationPrerequisitesAvailable()) {
                    store.resume(requestedSessionId);
                } else {
                    // Android 14 re-checks location permission in startForeground(). This
                    // service is already foreground from the paused notification, so avoid
                    // re-entering that call and keep the paused Lock Screen controls alive.
                    stopLocationUpdates();
                    NativeWalkRecorderPlugin.emitWalkUpdate(this, false);
                    refreshNotification();
                    scheduleNotificationTicks();
                    return START_STICKY;
                }
                NativeWalkRecorderPlugin.emitWalkUpdate(this, false);
            }

            String status = store.status();
            if (WalkRecordingStore.STATUS_IDLE.equals(status) || WalkRecordingStore.STATUS_STOPPED.equals(status)) {
                finishService();
                return START_NOT_STICKY;
            }

            ensureForeground();
            if (WalkRecordingStore.STATUS_RECORDING.equals(status)) {
                startLocationUpdates();
            } else {
                stopLocationUpdates();
            }
            scheduleNotificationTicks();
            if (ACTION_START.equals(action)) {
                NativeWalkRecorderPlugin.emitWalkUpdate(this, false);
            }
        } catch (Exception error) {
            try {
                if (WalkRecordingStore.STATUS_RECORDING.equals(store.status())) {
                    store.pause(null);
                    NativeWalkRecorderPlugin.emitWalkUpdate(this, false);
                }
            } catch (Exception ignored) {
                // Preserve the original failure path; the next visible snapshot can still recover the database.
            }
            finishService();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onLocationChanged(@NonNull Location location) {
        boolean accepted = store.record(location);
        if (accepted) {
            NativeWalkRecorderPlugin.emitWalkUpdate(this, false);
        }
        // Raw-fix freshness changes even when anti-jitter rejects the point.
        refreshNotification();
    }

    @Override
    public void onProviderEnabled(@NonNull String provider) {
        // No-op: the next provider update will refresh the recording and radar.
    }

    @Override
    public void onProviderDisabled(@NonNull String provider) {
        if (!locationPrerequisitesAvailable()) {
            pauseForUnavailableLocation();
        } else {
            refreshNotification();
        }
    }

    @Deprecated
    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {
        // Retained for Android 7 compatibility.
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        notificationHandler.removeCallbacks(notificationTicker);
        stopLocationUpdates();
        if (locationThread != null) {
            locationThread.quitSafely();
            locationThread = null;
        }
        super.onDestroy();
    }

    private void startLocationUpdates() {
        if (listening) {
            return;
        }
        if (!hasPreciseLocationPermission()) {
            throw new SecurityException("Precise location permission is required for walk recording.");
        }
        if (!locationServicesEnabled()) {
            throw new IllegalStateException("Location Services are unavailable for walk recording.");
        }
        boolean requested = false;
        if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            try {
                locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    UPDATE_INTERVAL_MS,
                    UPDATE_DISTANCE_METERS,
                    this,
                    locationThread.getLooper()
                );
                requested = true;
            } catch (SecurityException ignored) {
                // Try the network provider before failing the session.
            }
        }
        if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            try {
                locationManager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    UPDATE_INTERVAL_MS,
                    UPDATE_DISTANCE_METERS,
                    this,
                    locationThread.getLooper()
                );
                requested = true;
            } catch (SecurityException ignored) {
                // Report a single actionable failure below if neither provider can be registered.
            }
        }
        listening = requested;
        if (!requested) {
            throw new IllegalStateException("Location Services are unavailable for walk recording.");
        }
    }

    private void stopLocationUpdates() {
        if (!listening) {
            return;
        }
        try {
            locationManager.removeUpdates(this);
        } catch (SecurityException ignored) {
            // Permission may have been revoked while recording.
        }
        listening = false;
    }

    private boolean hasPreciseLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean locationServicesEnabled() {
        if (locationManager == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return locationManager.isLocationEnabled();
        }
        return locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
            locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    private boolean locationPrerequisitesAvailable() {
        return hasPreciseLocationPermission() && locationServicesEnabled();
    }

    private boolean isHeartbeatStale() {
        long heartbeatAt = store.heartbeatAt();
        return heartbeatAt <= 0L || System.currentTimeMillis() - heartbeatAt > SERVICE_STALE_AFTER_MS;
    }

    private void pauseForUnavailableLocation() {
        try {
            if (WalkRecordingStore.STATUS_RECORDING.equals(store.status())) {
                store.pause(null);
                stopLocationUpdates();
                NativeWalkRecorderPlugin.emitWalkUpdate(this, false);
            }
        } catch (Exception ignored) {
            // The persisted snapshot remains the source of truth for the next visible recovery.
        }
        refreshNotification();
    }

    private void ensureForeground() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void refreshNotification() {
        String status = store.status();
        if (WalkRecordingStore.STATUS_IDLE.equals(status) || WalkRecordingStore.STATUS_STOPPED.equals(status)) {
            return;
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildNotification());
    }

    private Notification buildNotification() {
        JSObject snapshot = store.snapshot(false);
        String status = snapshot.getString("status", WalkRecordingStore.STATUS_IDLE);
        String sessionId = snapshot.getString("sessionId", null);
        boolean paused = WalkRecordingStore.STATUS_PAUSED.equals(status);
        long elapsedMs = snapshot.optLong("elapsedMs", 0L);
        double distanceMeters = snapshot.optDouble("distanceMeters", 0d);
        JSONObject context = store.context();
        RadarSnapshot radar = radarSnapshot(context, store.lastPoint());
        WalkRecordingPolicy.FixFreshness fixFreshness = WalkRecordingPolicy.fixFreshness(
            System.currentTimeMillis(),
            snapshot.optLong("lastRawFixAt", 0L),
            snapshot.optLong("lastAcceptedFixAt", 0L)
        );

        String metrics = formatElapsed(elapsedMs) + " walked · " + formatWalkDistance(distanceMeters) + " recorded";
        String radarLine;
        String compact;
        if (paused) {
            radarLine = getString(R.string.walk_notification_radar_paused);
            compact = metrics;
        } else if (!radar.enabled) {
            radarLine = getString(R.string.walk_notification_radar_disabled);
            compact = metrics;
        } else if (fixFreshness == WalkRecordingPolicy.FixFreshness.SIGNAL_LOST) {
            radarLine = getString(R.string.walk_notification_signal_lost);
            compact = getString(R.string.walk_notification_signal_lost_short) + " · " + formatWalkDistance(distanceMeters);
        } else if (fixFreshness == WalkRecordingPolicy.FixFreshness.WAITING) {
            radarLine = getString(R.string.walk_notification_finding_fix);
            compact = getString(R.string.walk_notification_finding_fix_short) + " · " + formatWalkDistance(distanceMeters);
        } else if (!radar.visible.isEmpty()) {
            radarLine = radar.detail();
            compact = radar.visible.get(0).compact() + " · " + formatWalkDistance(distanceMeters);
        } else {
            radarLine = getString(
                R.string.walk_notification_no_places_in_range,
                formatWalkDistance(radar.rangeMeters)
            );
            compact = getString(R.string.walk_notification_no_nearby_short) + " · " + formatWalkDistance(distanceMeters);
        }
        String detail = paused ? "Recording paused\n" + radarLine + "\n" + metrics : radarLine + "\n" + metrics;

        PendingIntent openIntent = PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP),
            pendingIntentFlags()
        );
        PendingIntent pauseResumeIntent = PendingIntent.getService(
            this,
            pendingIntentRequestCode(paused ? ACTION_RESUME : ACTION_PAUSE, sessionId),
            intent(this, paused ? ACTION_RESUME : ACTION_PAUSE, sessionId),
            pendingIntentFlags()
        );
        PendingIntent endIntent = PendingIntent.getService(
            this,
            pendingIntentRequestCode(ACTION_STOP, sessionId),
            intent(this, ACTION_STOP, sessionId),
            pendingIntentFlags()
        );

        Notification publicVersion = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_walk_recording)
            .setContentTitle(getString(R.string.walk_notification_title))
            .setContentText(getString(R.string.walk_notification_public))
            .setContentIntent(openIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .addAction(
                R.drawable.ic_walk_recording,
                getString(paused ? R.string.walk_action_resume : R.string.walk_action_pause),
                pauseResumeIntent
            )
            .addAction(R.drawable.ic_walk_recording, getString(R.string.walk_action_end), endIntent)
            .build();

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_walk_recording)
            .setContentTitle(getString(paused ? R.string.walk_notification_paused : R.string.walk_notification_title))
            .setContentText(compact)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(detail))
            .setContentIntent(openIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .addAction(
                R.drawable.ic_walk_recording,
                getString(paused ? R.string.walk_action_resume : R.string.walk_action_pause),
                pauseResumeIntent
            )
            .addAction(R.drawable.ic_walk_recording, getString(R.string.walk_action_end), endIntent)
            .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            getString(R.string.walk_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getString(R.string.walk_notification_channel_description));
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        channel.setSound(null, null);
        channel.enableVibration(false);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.createNotificationChannel(channel);
    }

    private void scheduleNotificationTicks() {
        notificationHandler.removeCallbacks(notificationTicker);
        if (WalkRecordingStore.STATUS_RECORDING.equals(store.status())) {
            notificationHandler.postDelayed(notificationTicker, 15_000L);
        }
    }

    private void finishService() {
        notificationHandler.removeCallbacks(notificationTicker);
        stopLocationUpdates();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private static int pendingIntentFlags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    private static int pendingIntentRequestCode(String action, String sessionId) {
        return 31 * action.hashCode() + (sessionId == null ? 0 : sessionId.hashCode());
    }

    private static boolean isSessionBoundAction(String action) {
        return ACTION_START.equals(action) ||
            ACTION_PAUSE.equals(action) ||
            ACTION_RESUME.equals(action) ||
            ACTION_UPDATE.equals(action) ||
            ACTION_STOP.equals(action);
    }

    private static String formatElapsed(long elapsedMs) {
        long minutes = Math.max(0L, elapsedMs / 60_000L);
        if (minutes < 1) {
            return "<1 min";
        }
        if (minutes < 60) {
            return minutes + " min";
        }
        return String.format(Locale.getDefault(), "%dh %02dm", minutes / 60, minutes % 60);
    }

    private static String formatWalkDistance(double meters) {
        if (meters < 1_000d) {
            return String.format(Locale.getDefault(), "%.0f m", meters);
        }
        return String.format(Locale.getDefault(), "%.1f km", meters / 1_000d);
    }

    private static RadarSnapshot radarSnapshot(JSONObject context, WalkRecordingStore.LastPoint origin) {
        boolean enabled = context.optBoolean("lockScreenEnabled", true);
        double configuredRange = context.has("rangeM")
            ? context.optDouble("rangeM", 800d)
            : context.optDouble("rangeMeters", 800d);
        double rangeMeters = WalkRecordingPolicy.clampRadarRange(configuredRange);
        if (!enabled || origin == null) {
            return new RadarSnapshot(enabled, rangeMeters, null, new ArrayList<>());
        }

        Map<String, WalkRecordingPolicy.RadarCandidate> unique = new LinkedHashMap<>();
        appendCandidates(unique, context.optJSONArray("routeStops"), true);
        appendCandidates(unique, context.optJSONArray("radarCandidates"), false);
        // Older shells used these aliases. Primary arrays are inserted first so their route metadata wins.
        appendCandidates(unique, context.optJSONArray("candidates"), false);
        appendCandidates(unique, context.optJSONArray("targets"), false);
        appendCandidates(unique, context.optJSONArray("radarTargets"), false);

        JSONObject explicit = context.optJSONObject("nearest");
        if (explicit != null && unique.size() < MAX_CONTEXT_TARGETS) {
            addCandidate(unique, explicit, explicit.optBoolean("isRouteStop", false));
        }
        if (unique.isEmpty()) {
            String name = firstString(context, "nearestName", "name", "title");
            double latitude = firstDouble(context, "nearestLatitude", "latitude", "lat");
            double longitude = firstDouble(context, "nearestLongitude", "longitude", "lng", "lon");
            if (name != null && WalkRecordingPolicy.validCoordinate(latitude, longitude)) {
                unique.put(
                    "explicit|" + name + "|" + latitude + "|" + longitude,
                    new WalkRecordingPolicy.RadarCandidate(
                        "explicit",
                        name,
                        latitude,
                        longitude,
                        false,
                        0
                    )
                );
            }
        }

        List<WalkRecordingPolicy.RadarSelection> selections = WalkRecordingPolicy.nearestCandidates(
            origin.latitude,
            origin.longitude,
            new ArrayList<>(unique.values()),
            MAX_RENDERED_RADAR_TARGETS
        );
        RadarTarget nearest = selections.isEmpty() ? null : new RadarTarget(selections.get(0));
        List<RadarTarget> visible = new ArrayList<>();
        for (
            WalkRecordingPolicy.RadarSelection selection :
            WalkRecordingPolicy.withinRadarRange(
                selections,
                rangeMeters,
                MAX_RENDERED_RADAR_TARGETS
            )
        ) {
            visible.add(new RadarTarget(selection));
        }
        return new RadarSnapshot(enabled, rangeMeters, nearest, visible);
    }

    private static void appendCandidates(
        Map<String, WalkRecordingPolicy.RadarCandidate> unique,
        JSONArray candidates,
        boolean routeStopSource
    ) {
        if (candidates == null || unique.size() >= MAX_CONTEXT_TARGETS) {
            return;
        }
        int count = Math.min(candidates.length(), MAX_CONTEXT_TARGETS);
        for (int index = 0; index < count && unique.size() < MAX_CONTEXT_TARGETS; index++) {
            JSONObject candidate = candidates.optJSONObject(index);
            if (candidate != null) {
                addCandidate(unique, candidate, routeStopSource || candidate.optBoolean("isRouteStop", false));
            }
        }
    }

    private static void addCandidate(
        Map<String, WalkRecordingPolicy.RadarCandidate> unique,
        JSONObject candidate,
        boolean routeStop
    ) {
        if (candidate.optBoolean("isCompleted", false) || candidate.optBoolean("completed", false)) {
            return;
        }
        String name = firstString(candidate, "name", "n", "title", "label");
        double latitude = firstDouble(candidate, "latitude", "lat");
        double longitude = firstDouble(candidate, "longitude", "lng", "lon");
        if (name == null || !WalkRecordingPolicy.validCoordinate(latitude, longitude)) {
            return;
        }
        if (name.length() > 80) {
            name = name.substring(0, 80);
        }
        String id = firstString(candidate, "id", "spotId", "key");
        if (id == null) {
            id = name + "|" + latitude + "|" + longitude;
        }
        if (unique.containsKey(id)) {
            return;
        }
        unique.put(
            id,
            new WalkRecordingPolicy.RadarCandidate(
                id,
                name,
                latitude,
                longitude,
                routeStop,
                Math.max(0, candidate.optInt("ordinal", 0))
            )
        );
    }

    private static String firstString(JSONObject object, String... keys) {
        for (String key : keys) {
            String value = object.optString(key, "").trim();
            if (!value.isEmpty()) {
                return value;
            }
        }
        return null;
    }

    private static double firstDouble(JSONObject object, String... keys) {
        for (String key : keys) {
            if (object.has(key)) {
                double value = object.optDouble(key, Double.NaN);
                if (Double.isFinite(value)) {
                    return value;
                }
            }
        }
        return Double.NaN;
    }

    private static String cardinal(double bearing) {
        String[] labels = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" };
        return labels[((int) Math.floor((bearing + 22.5d) / 45d)) % labels.length];
    }

    private static String arrow(double bearing) {
        String[] arrows = { "↑", "↗", "→", "↘", "↓", "↙", "←", "↖" };
        return arrows[((int) Math.floor((bearing + 22.5d) / 45d)) % arrows.length];
    }

    private static final class RadarTarget {
        final String id;
        final String name;
        final double distanceMeters;
        final String direction;
        final String arrow;
        final boolean isRouteStop;
        final int ordinal;

        RadarTarget(WalkRecordingPolicy.RadarSelection selection) {
            this.id = selection.candidate.id;
            this.name = selection.candidate.name;
            this.distanceMeters = selection.distanceMeters;
            this.direction = cardinal(selection.bearingDegrees);
            this.arrow = arrow(selection.bearingDegrees);
            this.isRouteStop = selection.candidate.isRouteStop;
            this.ordinal = selection.candidate.ordinal;
        }

        String compact() {
            return arrow + " " + direction + " " + formatWalkDistance(distanceMeters);
        }

        String summary() {
            String targetLabel = name;
            if (isRouteStop) {
                targetLabel = ordinal > 0 ? "stop " + ordinal + ": " + name : "route stop: " + name;
            }
            return compact() + " to " + targetLabel;
        }
    }

    private static final class RadarSnapshot {
        final boolean enabled;
        final double rangeMeters;
        final RadarTarget nearest;
        final List<RadarTarget> visible;

        RadarSnapshot(boolean enabled, double rangeMeters, RadarTarget nearest, List<RadarTarget> visible) {
            this.enabled = enabled;
            this.rangeMeters = rangeMeters;
            this.nearest = nearest;
            this.visible = visible;
        }

        String detail() {
            StringBuilder detail = new StringBuilder();
            for (RadarTarget target : visible) {
                if (detail.length() > 0) {
                    detail.append('\n');
                }
                detail.append(target.summary());
            }
            return detail.toString();
        }
    }
}
