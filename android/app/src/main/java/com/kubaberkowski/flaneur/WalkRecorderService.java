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
import java.util.Locale;
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
            }
            if (!WalkRecordingStore.STATUS_IDLE.equals(status) && !WalkRecordingStore.STATUS_STOPPED.equals(status)) {
                refreshNotification();
                notificationHandler.postDelayed(this, 15_000L);
            } else {
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
        if (store.record(location)) {
            NativeWalkRecorderPlugin.emitWalkUpdate(this, false);
            refreshNotification();
        }
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
        RadarTarget radar = nearestRadarTarget(store.context(), store.lastPoint());

        String radarLine = radar == null ? "Finding nearby places…" : radar.summary();
        String metrics = formatElapsed(elapsedMs) + " walked · " + formatWalkDistance(distanceMeters) + " recorded";
        String compact = paused ? metrics : (radar == null ? metrics : radar.compact() + " · " + formatWalkDistance(distanceMeters));
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
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
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
        notificationHandler.postDelayed(notificationTicker, 15_000L);
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

    private static RadarTarget nearestRadarTarget(JSONObject context, WalkRecordingStore.LastPoint origin) {
        if (!context.optBoolean("lockScreenEnabled", true)) {
            return null;
        }
        if (origin == null) {
            return explicitRadarTarget(context, null);
        }

        JSONArray routeStops = context.optJSONArray("routeStops");
        if (routeStops != null) {
            for (int index = 0; index < Math.min(routeStops.length(), 250); index++) {
                JSONObject stop = routeStops.optJSONObject(index);
                if (stop == null || stop.optBoolean("isCompleted", false)) {
                    continue;
                }
                RadarTarget target = targetFromObject(stop, origin);
                if (target != null) {
                    return target;
                }
            }
        }

        RadarTarget nearest = null;
        String[] candidateKeys = { "radarCandidates", "candidates", "targets", "radarTargets", "routeStops" };
        for (String key : candidateKeys) {
            nearest = nearestInArray(context.optJSONArray(key), origin, nearest);
        }
        return nearest == null ? explicitRadarTarget(context, origin) : nearest;
    }

    private static RadarTarget nearestInArray(
        JSONArray candidates,
        WalkRecordingStore.LastPoint origin,
        RadarTarget currentNearest
    ) {
        if (candidates == null) {
            return currentNearest;
        }
        RadarTarget nearest = currentNearest;
        int count = Math.min(candidates.length(), 250);
        for (int index = 0; index < count; index++) {
            JSONObject candidate = candidates.optJSONObject(index);
            if (candidate == null || candidate.optBoolean("isCompleted", false)) {
                continue;
            }
            RadarTarget target = targetFromObject(candidate, origin);
            if (target != null && (nearest == null || target.distanceMeters < nearest.distanceMeters)) {
                nearest = target;
            }
        }
        return nearest;
    }

    private static RadarTarget explicitRadarTarget(JSONObject context, WalkRecordingStore.LastPoint origin) {
        JSONObject nearest = context.optJSONObject("nearest");
        if (nearest != null) {
            RadarTarget target = targetFromObject(nearest, origin);
            if (target != null) {
                return target;
            }
        }
        String name = firstString(context, "nearestName", "name", "title");
        double latitude = firstDouble(context, "nearestLatitude", "latitude", "lat");
        double longitude = firstDouble(context, "nearestLongitude", "longitude", "lng", "lon");
        double distance = context.optDouble("nearestDistanceMeters", Double.NaN);
        if (name == null) {
            return null;
        }
        if (origin != null && validCoordinate(latitude, longitude)) {
            distance = WalkRecordingStore.distanceMeters(origin.latitude, origin.longitude, latitude, longitude);
            double bearing = WalkRecordingStore.bearingDegrees(origin.latitude, origin.longitude, latitude, longitude);
            return new RadarTarget(name, distance, bearing);
        }
        String direction = context.optString("nearestDirection", "");
        if (Double.isFinite(distance) && !direction.isEmpty()) {
            return new RadarTarget(name, distance, direction);
        }
        return null;
    }

    private static RadarTarget targetFromObject(JSONObject candidate, WalkRecordingStore.LastPoint origin) {
        if (candidate == null || origin == null) {
            return null;
        }
        String name = firstString(candidate, "name", "title", "label");
        double latitude = firstDouble(candidate, "latitude", "lat");
        double longitude = firstDouble(candidate, "longitude", "lng", "lon");
        if (name == null || !validCoordinate(latitude, longitude)) {
            return null;
        }
        double distance = WalkRecordingStore.distanceMeters(origin.latitude, origin.longitude, latitude, longitude);
        double bearing = WalkRecordingStore.bearingDegrees(origin.latitude, origin.longitude, latitude, longitude);
        return new RadarTarget(name, distance, bearing);
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

    private static boolean validCoordinate(double latitude, double longitude) {
        return (
            Double.isFinite(latitude) &&
            Double.isFinite(longitude) &&
            Math.abs(latitude) <= 90d &&
            Math.abs(longitude) <= 180d
        );
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
        final String name;
        final double distanceMeters;
        final String direction;
        final String arrow;

        RadarTarget(String name, double distanceMeters, double bearing) {
            this(name, distanceMeters, cardinal(bearing), arrow(bearing));
        }

        RadarTarget(String name, double distanceMeters, String direction) {
            this(name, distanceMeters, direction, "•");
        }

        RadarTarget(String name, double distanceMeters, String direction, String arrow) {
            this.name = name;
            this.distanceMeters = distanceMeters;
            this.direction = direction;
            this.arrow = arrow;
        }

        String compact() {
            return arrow + " " + direction + " " + formatWalkDistance(distanceMeters);
        }

        String summary() {
            return compact() + " to " + name;
        }
    }
}
