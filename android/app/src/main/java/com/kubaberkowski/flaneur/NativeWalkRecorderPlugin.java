package com.kubaberkowski.flaneur;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.lang.ref.WeakReference;
import java.util.Iterator;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "NativeWalkRecorder",
    permissions = {
        @Permission(
            alias = "location",
            strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }
        ),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class NativeWalkRecorderPlugin extends Plugin {
    private static final long SERVICE_STALE_AFTER_MS = 120_000L;
    private static WeakReference<NativeWalkRecorderPlugin> activeInstance = new WeakReference<>(null);

    @Override
    public void load() {
        super.load();
        activeInstance = new WeakReference<>(this);
    }

    @Override
    protected void handleOnDestroy() {
        NativeWalkRecorderPlugin plugin = activeInstance.get();
        if (plugin == this) {
            activeInstance.clear();
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!hasPreciseLocationPermission()) {
            String code = hasApproximateLocationPermission() ? "PRECISE_LOCATION_REQUIRED" : "LOCATION_PERMISSION_REQUIRED";
            call.reject("Turn on Precise Location before starting a background walk.", code);
            return;
        }
        if (!locationServicesEnabled()) {
            call.reject("Turn on Location Services before starting a background walk.", "LOCATION_SERVICES_DISABLED");
            return;
        }
        if (
            getActivity() == null ||
            !getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED)
        ) {
            call.reject("Start the walk while Flâneur is visible.", "FOREGROUND_START_REQUIRED");
            return;
        }

        String sessionId = call.getString("sessionId");
        if (sessionId == null || sessionId.trim().isEmpty()) {
            sessionId = UUID.randomUUID().toString();
        }
        long startedAt = call.getData().optLong("startedAt", System.currentTimeMillis());
        WalkRecordingStore store = WalkRecordingStore.get(getContext());
        try {
            JSObject result = store.start(sessionId, startedAt, normalizedContext(call.getData()));
            Intent intent = WalkRecorderService.intent(getContext(), WalkRecorderService.ACTION_START, sessionId);
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve(result);
        } catch (Exception error) {
            pauseFailedServiceStart(store, sessionId);
            call.reject(error.getMessage(), "START_FAILED", error);
        }
    }

    @PluginMethod
    public void pause(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (rejectMissingSessionId(call, sessionId)) {
            return;
        }
        try {
            JSObject result = WalkRecordingStore.get(getContext()).pause(sessionId);
            getContext().startService(
                WalkRecorderService.intent(getContext(), WalkRecorderService.ACTION_PAUSE, sessionId)
            );
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), "PAUSE_FAILED", error);
        }
    }

    @PluginMethod
    public void resume(PluginCall call) {
        if (!hasPreciseLocationPermission()) {
            String code = hasApproximateLocationPermission() ? "PRECISE_LOCATION_REQUIRED" : "LOCATION_PERMISSION_REQUIRED";
            call.reject("Turn on Precise Location before resuming a background walk.", code);
            return;
        }
        if (!locationServicesEnabled()) {
            call.reject("Turn on Location Services before resuming a background walk.", "LOCATION_SERVICES_DISABLED");
            return;
        }
        String sessionId = call.getString("sessionId");
        if (rejectMissingSessionId(call, sessionId)) {
            return;
        }
        WalkRecordingStore store = WalkRecordingStore.get(getContext());
        try {
            JSObject result = store.resume(sessionId);
            Intent intent = WalkRecorderService.intent(getContext(), WalkRecorderService.ACTION_RESUME, sessionId);
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve(result);
        } catch (Exception error) {
            pauseFailedServiceStart(store, sessionId);
            call.reject(error.getMessage(), "RESUME_FAILED", error);
        }
    }

    @PluginMethod
    public void updateContext(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (rejectMissingSessionId(call, sessionId)) {
            return;
        }
        try {
            JSObject result = WalkRecordingStore.get(getContext()).updateContext(
                sessionId,
                normalizedContext(call.getData())
            );
            String status = result.getString("status", WalkRecordingStore.STATUS_IDLE);
            if (!WalkRecordingStore.STATUS_IDLE.equals(status) && !WalkRecordingStore.STATUS_STOPPED.equals(status)) {
                getContext().startService(
                    WalkRecorderService.intent(
                        getContext(),
                        WalkRecorderService.ACTION_UPDATE,
                        sessionId
                    )
                );
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), "CONTEXT_UPDATE_FAILED", error);
        }
    }

    @PluginMethod
    public void snapshot(PluginCall call) {
        WalkRecordingStore store = WalkRecordingStore.get(getContext());
        JSObject result = store.snapshot(true);
        if (
            WalkRecordingStore.STATUS_RECORDING.equals(result.getString("status", WalkRecordingStore.STATUS_IDLE)) &&
            !WalkRecorderService.isRunning()
        ) {
            String sessionId = result.getString("sessionId", null);
            long heartbeatAt = result.optLong("heartbeatAt", store.heartbeatAt());
            boolean stale = heartbeatAt <= 0L || System.currentTimeMillis() - heartbeatAt > SERVICE_STALE_AFTER_MS;
            boolean visible = getActivity() != null &&
                getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED);
            if (stale) {
                result = store.pauseStale(sessionId);
            } else if (visible && hasPreciseLocationPermission() && locationServicesEnabled()) {
                try {
                    ContextCompat.startForegroundService(
                        getContext(),
                        WalkRecorderService.intent(getContext(), WalkRecorderService.ACTION_START, sessionId)
                    );
                } catch (RuntimeException error) {
                    result = store.pause(sessionId);
                }
            } else {
                result = store.pause(sessionId);
            }
        }
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (rejectMissingSessionId(call, sessionId)) {
            return;
        }
        try {
            JSObject result = WalkRecordingStore.get(getContext()).stop(sessionId);
            stopServiceRecording(result.getString("sessionId", sessionId));
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), "STOP_FAILED", error);
        }
    }

    @PluginMethod
    public void acknowledge(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (rejectMissingSessionId(call, sessionId)) {
            return;
        }
        boolean cleared = WalkRecordingStore.get(getContext()).clear(sessionId, true);
        if (!cleared) {
            call.reject("Only the matching stopped walk can be acknowledged.", "ACKNOWLEDGE_FAILED");
            return;
        }
        JSObject result = new JSObject();
        result.put("acknowledged", true);
        result.put("status", WalkRecordingStore.STATUS_IDLE);
        call.resolve(result);
    }

    @PluginMethod
    public void discard(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (rejectMissingSessionId(call, sessionId)) {
            return;
        }
        boolean cleared = WalkRecordingStore.get(getContext()).clear(sessionId, false);
        if (!cleared) {
            call.reject("The pending native walk does not match this session.", "DISCARD_FAILED");
            return;
        }
        forceStopService();
        JSObject result = new JSObject();
        result.put("discarded", true);
        result.put("status", WalkRecordingStore.STATUS_IDLE);
        call.resolve(result);
    }

    private boolean hasPreciseLocationPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasApproximateLocationPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean locationServicesEnabled() {
        LocationManager manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return manager.isLocationEnabled();
        }
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER) || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    private void stopServiceRecording(String sessionId) {
        try {
            getContext().startService(
                WalkRecorderService.intent(getContext(), WalkRecorderService.ACTION_STOP, sessionId)
            );
        } catch (RuntimeException ignored) {
            forceStopService();
        }
    }

    private void forceStopService() {
        getContext().stopService(new Intent(getContext(), WalkRecorderService.class));
    }

    private static boolean rejectMissingSessionId(PluginCall call, String sessionId) {
        if (sessionId != null && !sessionId.trim().isEmpty()) {
            return false;
        }
        call.reject("A walk session identifier is required.", "SESSION_ID_REQUIRED");
        return true;
    }

    private static void pauseFailedServiceStart(WalkRecordingStore store, String sessionId) {
        try {
            if (store.matchesSession(sessionId) && WalkRecordingStore.STATUS_RECORDING.equals(store.status())) {
                store.pause(sessionId);
            }
        } catch (Exception ignored) {
            // A later snapshot can still reconcile the transactional store.
        }
    }

    /**
     * Accept either { context: {...} } or direct fields. This keeps the bridge tolerant while
     * the web shell rolls out and lets it pass a compact candidates/targets array for lock-screen radar.
     */
    private static JSONObject normalizedContext(JSObject data) throws JSONException {
        JSONObject context = new JSONObject();
        JSONObject nested = data.optJSONObject("context");
        if (nested != null) {
            copy(nested, context);
        }
        copyIfPresent(data, context, "city");
        copyIfPresent(data, context, "cityLabel");
        copyIfPresent(data, context, "nearest");
        copyIfPresent(data, context, "nearestName");
        copyIfPresent(data, context, "nearestLatitude");
        copyIfPresent(data, context, "nearestLongitude");
        copyIfPresent(data, context, "candidates");
        copyIfPresent(data, context, "targets");
        copyIfPresent(data, context, "radarTargets");
        copyIfPresent(data, context, "routeStops");
        copyIfPresent(data, context, "radarCandidates");
        copyIfPresent(data, context, "rangeM");
        copyIfPresent(data, context, "lockScreenEnabled");
        return context;
    }

    private static void copy(JSONObject from, JSONObject to) throws JSONException {
        Iterator<String> keys = from.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            to.put(key, from.get(key));
        }
    }

    private static void copyIfPresent(JSONObject from, JSONObject to, String key) throws JSONException {
        if (from.has(key) && !from.isNull(key)) {
            to.put(key, from.get(key));
        }
    }

    /** Sends only accepted native state changes; the weak reference never keeps a WebView alive. */
    static void emitWalkUpdate(final Context context, boolean includePoints) {
        final NativeWalkRecorderPlugin plugin = activeInstance.get();
        if (plugin == null) {
            return;
        }
        final JSObject snapshot = WalkRecordingStore.get(context).snapshot(includePoints);
        Runnable emit = () -> {
            if (activeInstance.get() == plugin) {
                plugin.notifyListeners("walkUpdate", snapshot, false);
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) {
            emit.run();
        } else {
            new Handler(Looper.getMainLooper()).post(emit);
        }
    }
}
