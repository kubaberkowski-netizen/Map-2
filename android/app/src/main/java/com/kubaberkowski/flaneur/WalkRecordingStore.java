package com.kubaberkowski.flaneur;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.location.Location;
import android.os.SystemClock;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * A small, transactional store shared by the Capacitor plugin and foreground service.
 * There is intentionally only one pending native walk: JavaScript acknowledges a stopped
 * session after importing it, preventing a second start from silently overwriting points.
 */
final class WalkRecordingStore extends SQLiteOpenHelper {
    static final String STATUS_IDLE = "idle";
    static final String STATUS_RECORDING = "recording";
    static final String STATUS_PAUSED = "paused";
    static final String STATUS_STOPPED = "stopped";

    private static final String DATABASE_NAME = "flaneur-native-walk.db";
    private static final int DATABASE_VERSION = 3;
    private static WalkRecordingStore instance;

    private final WalkRecordingPolicy.MotionGate motionGate = new WalkRecordingPolicy.MotionGate();
    private String motionGateSessionId;

    static synchronized WalkRecordingStore get(Context context) {
        if (instance == null) {
            instance = new WalkRecordingStore(context.getApplicationContext());
        }
        return instance;
    }

    private WalkRecordingStore(Context context) {
        super(context, DATABASE_NAME, null, DATABASE_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "CREATE TABLE session (" +
            "session_id TEXT PRIMARY KEY," +
            "status TEXT NOT NULL," +
            "started_at INTEGER NOT NULL," +
            "active_started_at INTEGER NOT NULL DEFAULT 0," +
            "active_elapsed_ms INTEGER NOT NULL DEFAULT 0," +
            "heartbeat_at INTEGER NOT NULL DEFAULT 0," +
            "last_raw_fix_at INTEGER NOT NULL DEFAULT 0," +
            "last_accepted_fix_at INTEGER NOT NULL DEFAULT 0," +
            "ended_at INTEGER NOT NULL DEFAULT 0," +
            "distance_m REAL NOT NULL DEFAULT 0," +
            "force_segment INTEGER NOT NULL DEFAULT 1," +
            "context_json TEXT NOT NULL DEFAULT '{}')"
        );
        db.execSQL(
            "CREATE TABLE points (" +
            "row_id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "session_id TEXT NOT NULL," +
            "latitude REAL NOT NULL," +
            "longitude REAL NOT NULL," +
            "accuracy REAL NOT NULL," +
            "timestamp INTEGER NOT NULL," +
            "starts_new_segment INTEGER NOT NULL DEFAULT 0)"
        );
        db.execSQL("CREATE INDEX points_session_order ON points(session_id, row_id)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE session ADD COLUMN heartbeat_at INTEGER NOT NULL DEFAULT 0");
            db.execSQL(
                "UPDATE session SET heartbeat_at = CASE " +
                "WHEN active_started_at > 0 THEN active_started_at ELSE started_at END " +
                "WHERE heartbeat_at = 0"
            );
        }
        if (oldVersion < 3) {
            db.execSQL("ALTER TABLE session ADD COLUMN last_raw_fix_at INTEGER NOT NULL DEFAULT 0");
            db.execSQL("ALTER TABLE session ADD COLUMN last_accepted_fix_at INTEGER NOT NULL DEFAULT 0");
            db.execSQL(
                "UPDATE session SET last_accepted_fix_at = COALESCE(" +
                "(SELECT MAX(timestamp) FROM points WHERE points.session_id = session.session_id), 0)"
            );
            db.execSQL("UPDATE session SET last_raw_fix_at = last_accepted_fix_at");
        }
    }

    synchronized JSObject start(String sessionId, long startedAt, JSONObject context) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Session current = readSession(db);
            if (current != null) {
                if (current.sessionId.equals(sessionId) && !STATUS_STOPPED.equals(current.status)) {
                    ensureMotionGate(db, current);
                    db.setTransactionSuccessful();
                    return snapshot(db, true);
                }
                throw new IllegalStateException("A native walk is still pending. Stop and acknowledge or discard it first.");
            }

            long now = System.currentTimeMillis();
            ContentValues values = new ContentValues();
            values.put("session_id", sessionId);
            values.put("status", STATUS_RECORDING);
            values.put("started_at", startedAt > 0 && startedAt <= now ? startedAt : now);
            values.put("active_started_at", now);
            values.put("active_elapsed_ms", 0L);
            values.put("heartbeat_at", now);
            values.put("last_raw_fix_at", 0L);
            values.put("last_accepted_fix_at", 0L);
            values.put("ended_at", 0L);
            values.put("distance_m", 0d);
            values.put("force_segment", 1);
            values.put("context_json", context == null ? "{}" : context.toString());
            db.insertOrThrow("session", null, values);
            resetMotionGate(sessionId, null, true);
            db.setTransactionSuccessful();
            return snapshot(db, true);
        } finally {
            db.endTransaction();
        }
    }

    synchronized JSObject pause(String expectedSessionId) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Session session = readSession(db);
            requireMatchingSession(session, expectedSessionId);
            if (session == null || STATUS_STOPPED.equals(session.status)) {
                throw new IllegalStateException("There is no active native walk to pause.");
            }
            if (STATUS_RECORDING.equals(session.status)) {
                pauseAt(db, session, System.currentTimeMillis());
            }
            resetMotionGate(
                session.sessionId,
                toMotionPoint(readLastPoint(db, session.sessionId)),
                true
            );
            db.setTransactionSuccessful();
            return snapshot(db, true);
        } finally {
            db.endTransaction();
        }
    }

    /**
     * Pauses a recording whose service heartbeat has gone stale without counting process-death
     * downtime as walking time. The last heartbeat is clamped to the active interval.
     */
    synchronized JSObject pauseStale(String expectedSessionId) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Session session = readSession(db);
            requireMatchingSession(session, expectedSessionId);
            if (session == null || STATUS_STOPPED.equals(session.status)) {
                throw new IllegalStateException("There is no active native walk to recover.");
            }
            if (STATUS_RECORDING.equals(session.status)) {
                long now = System.currentTimeMillis();
                long heartbeat = session.heartbeatAt > 0 ? session.heartbeatAt : session.activeStartedAt;
                pauseAt(db, session, Math.min(now, Math.max(session.activeStartedAt, heartbeat)));
            }
            resetMotionGate(
                session.sessionId,
                toMotionPoint(readLastPoint(db, session.sessionId)),
                true
            );
            db.setTransactionSuccessful();
            return snapshot(db, true);
        } finally {
            db.endTransaction();
        }
    }

    synchronized JSObject resume(String expectedSessionId) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Session session = readSession(db);
            requireMatchingSession(session, expectedSessionId);
            if (session == null || STATUS_STOPPED.equals(session.status)) {
                throw new IllegalStateException("There is no paused native walk to resume.");
            }
            if (STATUS_PAUSED.equals(session.status)) {
                long now = System.currentTimeMillis();
                ContentValues values = new ContentValues();
                values.put("status", STATUS_RECORDING);
                values.put("active_started_at", now);
                values.put("heartbeat_at", now);
                values.put("last_raw_fix_at", 0L);
                values.put("ended_at", 0L);
                values.put("force_segment", 1);
                db.update("session", values, "session_id = ?", new String[] { session.sessionId });
                resetMotionGate(
                    session.sessionId,
                    toMotionPoint(readLastPoint(db, session.sessionId)),
                    true
                );
            } else {
                ensureMotionGate(db, session);
            }
            db.setTransactionSuccessful();
            return snapshot(db, true);
        } finally {
            db.endTransaction();
        }
    }

    synchronized JSObject stop(String expectedSessionId) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Session session = readSession(db);
            requireMatchingSession(session, expectedSessionId);
            if (session == null) {
                clearMotionGate();
                db.setTransactionSuccessful();
                return emptySnapshot();
            }
            if (!STATUS_STOPPED.equals(session.status)) {
                long now = System.currentTimeMillis();
                ContentValues values = new ContentValues();
                values.put("status", STATUS_STOPPED);
                values.put("active_elapsed_ms", elapsedAt(session, now));
                values.put("active_started_at", 0L);
                values.put("heartbeat_at", now);
                values.put("ended_at", now);
                db.update("session", values, "session_id = ?", new String[] { session.sessionId });
            }
            clearMotionGate();
            db.setTransactionSuccessful();
            return snapshot(db, true);
        } finally {
            db.endTransaction();
        }
    }

    synchronized JSObject updateContext(String expectedSessionId, JSONObject context) {
        SQLiteDatabase db = getWritableDatabase();
        Session session = readSession(db);
        requireMatchingSession(session, expectedSessionId);
        if (session == null) {
            return emptySnapshot();
        }
        ContentValues values = new ContentValues();
        values.put("context_json", context == null ? "{}" : context.toString());
        db.update("session", values, "session_id = ?", new String[] { session.sessionId });
        return snapshot(db, false);
    }

    /** Accepts a current, plausible pedestrian fix and separately persists raw GPS liveness. */
    synchronized boolean record(Location location) {
        if (location == null) {
            return false;
        }
        double latitude = location.getLatitude();
        double longitude = location.getLongitude();
        if (!WalkRecordingPolicy.validCoordinate(latitude, longitude)) {
            return false;
        }

        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Session session = readSession(db);
            if (session == null || !STATUS_RECORDING.equals(session.status)) {
                return false;
            }
            ensureMotionGate(db, session);

            long receivedAt = System.currentTimeMillis();
            long timestamp = location.getTime();
            long recordingStartedAt = Math.max(session.startedAt, session.activeStartedAt);
            if (!WalkRecordingPolicy.isFixTimestampUsable(timestamp, recordingStartedAt, receivedAt)) {
                return false;
            }
            long fixElapsedRealtimeNanos = location.getElapsedRealtimeNanos();
            if (
                fixElapsedRealtimeNanos > 0L &&
                !WalkRecordingPolicy.isElapsedRealtimeUsable(
                    fixElapsedRealtimeNanos,
                    SystemClock.elapsedRealtimeNanos()
                )
            ) {
                return false;
            }
            LastPoint last = readLastPoint(db, session.sessionId);
            if (last != null && timestamp <= last.timestamp) {
                return false;
            }

            ContentValues rawFix = new ContentValues();
            rawFix.put("last_raw_fix_at", receivedAt);
            rawFix.put("heartbeat_at", receivedAt);
            db.update("session", rawFix, "session_id = ?", new String[] { session.sessionId });

            if (
                !location.hasAccuracy() ||
                !Float.isFinite(location.getAccuracy()) ||
                location.getAccuracy() <= 0 ||
                location.getAccuracy() > 65f
            ) {
                db.setTransactionSuccessful();
                return false;
            }

            WalkRecordingPolicy.MotionPoint candidate = new WalkRecordingPolicy.MotionPoint(
                latitude,
                longitude,
                timestamp,
                location.getAccuracy()
            );
            Float reportedSpeed = location.hasSpeed() ? location.getSpeed() : null;
            WalkRecordingPolicy.MotionGateResult gateResult = motionGate.accept(
                candidate,
                reportedSpeed
            );

            boolean inserted = false;
            if (!gateResult.emissions.isEmpty()) {
                inserted = persistEmissions(db, session, gateResult.emissions, receivedAt);
            } else if (gateResult.vehicleMode) {
                markVehicleMode(db, session.sessionId);
            }
            db.setTransactionSuccessful();
            return inserted;
        } finally {
            db.endTransaction();
        }
    }

    private static void markVehicleMode(SQLiteDatabase db, String sessionId) {
        ContentValues update = new ContentValues();
        update.put("force_segment", 1);
        update.put("last_accepted_fix_at", 0L);
        db.update("session", update, "session_id = ?", new String[] { sessionId });
    }

    private static boolean persistEmissions(
        SQLiteDatabase db,
        Session session,
        List<WalkRecordingPolicy.MotionEmission> emissions,
        long receivedAt
    ) {
        LastPoint last = readLastPoint(db, session.sessionId);
        double distanceMeters = session.distanceMeters;
        boolean forceSegment = session.forceSegment;
        boolean insertedAny = false;

        for (WalkRecordingPolicy.MotionEmission emission : emissions) {
            WalkRecordingPolicy.MotionPoint candidate = emission.point;
            if (last != null && candidate.timestamp <= last.timestamp) {
                continue;
            }

            double stepDistance = 0d;
            long gapMs = 0L;
            if (last != null) {
                gapMs = candidate.timestamp - last.timestamp;
                stepDistance = distanceMeters(
                    last.latitude,
                    last.longitude,
                    candidate.latitude,
                    candidate.longitude
                );
            }
            boolean startsNewSegment = last == null ||
                forceSegment ||
                emission.startsNewSegment ||
                gapMs > 120_000L ||
                (gapMs > 30_000L && stepDistance > 500d);
            double movementFloor = Math.max(12d, candidate.accuracy / 2d);
            if (last != null && !startsNewSegment && stepDistance < movementFloor) {
                continue;
            }

            ContentValues point = new ContentValues();
            point.put("session_id", session.sessionId);
            point.put("latitude", candidate.latitude);
            point.put("longitude", candidate.longitude);
            point.put("accuracy", candidate.accuracy);
            point.put("timestamp", candidate.timestamp);
            point.put("starts_new_segment", startsNewSegment ? 1 : 0);
            long insertedRowId = db.insertOrThrow("points", null, point);
            int deleted = db.delete(
                "points",
                "session_id = ? AND row_id <= ?",
                new String[] { session.sessionId, Long.toString(insertedRowId - 6_000L) }
            );
            if (deleted > 0) {
                db.execSQL(
                    "UPDATE points SET starts_new_segment = 1 WHERE row_id = " +
                    "(SELECT MIN(row_id) FROM points WHERE session_id = ?)",
                    new Object[] { session.sessionId }
                );
            }

            if (!startsNewSegment) {
                distanceMeters += stepDistance;
            }
            last = new LastPoint(
                candidate.latitude,
                candidate.longitude,
                candidate.accuracy,
                candidate.timestamp,
                startsNewSegment
            );
            forceSegment = false;
            insertedAny = true;
        }

        ContentValues update = new ContentValues();
        update.put("force_segment", forceSegment ? 1 : 0);
        update.put("heartbeat_at", receivedAt);
        update.put("last_raw_fix_at", receivedAt);
        update.put("last_accepted_fix_at", receivedAt);
        update.put("distance_m", distanceMeters);
        db.update("session", update, "session_id = ?", new String[] { session.sessionId });
        return insertedAny;
    }

    synchronized JSObject snapshot(boolean includePoints) {
        return snapshot(getReadableDatabase(), includePoints);
    }

    synchronized boolean clear(String expectedSessionId, boolean requireStopped) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Session session = readSession(db);
            if (session == null) {
                clearMotionGate();
                db.setTransactionSuccessful();
                return true;
            }
            if (expectedSessionId != null && !expectedSessionId.isEmpty() && !expectedSessionId.equals(session.sessionId)) {
                return false;
            }
            if (requireStopped && !STATUS_STOPPED.equals(session.status)) {
                return false;
            }
            db.delete("points", "session_id = ?", new String[] { session.sessionId });
            db.delete("session", "session_id = ?", new String[] { session.sessionId });
            clearMotionGate();
            db.setTransactionSuccessful();
            return true;
        } finally {
            db.endTransaction();
        }
    }

    synchronized String status() {
        Session session = readSession(getReadableDatabase());
        return session == null ? STATUS_IDLE : session.status;
    }

    synchronized boolean matchesSession(String expectedSessionId) {
        Session session = readSession(getReadableDatabase());
        return session != null && WalkRecordingPolicy.sessionMatches(session.sessionId, expectedSessionId);
    }

    synchronized long heartbeatAt() {
        Session session = readSession(getReadableDatabase());
        return session == null ? 0L : session.heartbeatAt;
    }

    /** Updated by the live service even when GPS has not produced an accepted point. */
    synchronized void heartbeat() {
        SQLiteDatabase db = getWritableDatabase();
        Session session = readSession(db);
        if (session == null || !STATUS_RECORDING.equals(session.status)) {
            return;
        }
        ContentValues values = new ContentValues();
        values.put("heartbeat_at", System.currentTimeMillis());
        db.update("session", values, "session_id = ?", new String[] { session.sessionId });
    }

    synchronized JSONObject context() {
        Session session = readSession(getReadableDatabase());
        if (session == null) {
            return new JSONObject();
        }
        try {
            return new JSONObject(session.contextJson);
        } catch (JSONException ignored) {
            return new JSONObject();
        }
    }

    synchronized LastPoint lastPoint() {
        SQLiteDatabase db = getReadableDatabase();
        Session session = readSession(db);
        return session == null ? null : readLastPoint(db, session.sessionId);
    }

    private JSObject snapshot(SQLiteDatabase db, boolean includePoints) {
        Session session = readSession(db);
        if (session == null) {
            return emptySnapshot();
        }
        JSObject result = new JSObject();
        result.put("sessionId", session.sessionId);
        result.put("status", session.status);
        result.put("startedAt", session.startedAt);
        result.put("heartbeatAt", session.heartbeatAt);
        result.put("lastRawFixAt", session.lastRawFixAt);
        result.put("lastAcceptedFixAt", session.lastAcceptedFixAt);
        result.put("elapsedMs", elapsedAt(session, System.currentTimeMillis()));
        long elapsedAnchor = STATUS_STOPPED.equals(session.status) && session.endedAt > 0
            ? session.endedAt
            : System.currentTimeMillis();
        result.put("pausedMs", Math.max(0L, elapsedAnchor - session.startedAt - elapsedAt(session, elapsedAnchor)));
        result.put("distanceMeters", session.distanceMeters);
        LastPoint latest = readLastPoint(db, session.sessionId);
        if (latest != null) {
            JSObject latestPoint = new JSObject();
            latestPoint.put("latitude", latest.latitude);
            latestPoint.put("longitude", latest.longitude);
            latestPoint.put("accuracy", latest.accuracy);
            latestPoint.put("timestamp", latest.timestamp);
            latestPoint.put("startsNewSegment", latest.startsNewSegment);
            result.put("latestPoint", latestPoint);
        }
        try {
            result.put("context", new JSONObject(session.contextJson));
        } catch (JSONException ignored) {
            result.put("context", new JSONObject());
        }

        if (includePoints) {
            JSArray points = new JSArray();
            try (
                Cursor cursor = db.query(
                    "points",
                    new String[] { "latitude", "longitude", "accuracy", "timestamp", "starts_new_segment" },
                    "session_id = ?",
                    new String[] { session.sessionId },
                    null,
                    null,
                    "row_id ASC"
                )
            ) {
                while (cursor.moveToNext()) {
                    JSObject point = new JSObject();
                    point.put("latitude", cursor.getDouble(0));
                    point.put("longitude", cursor.getDouble(1));
                    point.put("accuracy", cursor.getDouble(2));
                    point.put("timestamp", cursor.getLong(3));
                    point.put("startsNewSegment", cursor.getInt(4) == 1);
                    points.put(point);
                }
            }
            result.put("points", points);
        }
        return result;
    }

    private static JSObject emptySnapshot() {
        JSObject result = new JSObject();
        result.put("status", STATUS_IDLE);
        result.put("elapsedMs", 0L);
        result.put("pausedMs", 0L);
        result.put("distanceMeters", 0d);
        result.put("points", new JSArray());
        return result;
    }

    private static long elapsedAt(Session session, long now) {
        long elapsed = session.activeElapsedMs;
        if (STATUS_RECORDING.equals(session.status) && session.activeStartedAt > 0) {
            elapsed += Math.max(0L, now - session.activeStartedAt);
        }
        return elapsed;
    }

    private static void pauseAt(SQLiteDatabase db, Session session, long pausedAt) {
        ContentValues values = new ContentValues();
        values.put("status", STATUS_PAUSED);
        values.put("active_elapsed_ms", elapsedAt(session, pausedAt));
        values.put("active_started_at", 0L);
        values.put("heartbeat_at", pausedAt);
        values.put("force_segment", 1);
        db.update("session", values, "session_id = ?", new String[] { session.sessionId });
    }

    /**
     * A missing in-memory session means the process was recreated. Its unpersisted
     * buffer is intentionally gone, and the next trustworthy point starts a segment.
     */
    private void ensureMotionGate(SQLiteDatabase db, Session session) {
        if (session.sessionId.equals(motionGateSessionId)) {
            return;
        }
        resetMotionGate(
            session.sessionId,
            toMotionPoint(readLastPoint(db, session.sessionId)),
            true
        );
        ContentValues recovery = new ContentValues();
        recovery.put("force_segment", 1);
        db.update("session", recovery, "session_id = ?", new String[] { session.sessionId });
    }

    private void resetMotionGate(
        String sessionId,
        WalkRecordingPolicy.MotionPoint trustedReference,
        boolean startNewSegment
    ) {
        motionGate.reset(trustedReference, startNewSegment);
        motionGateSessionId = sessionId;
    }

    private void clearMotionGate() {
        motionGate.reset(null, true);
        motionGateSessionId = null;
    }

    private static WalkRecordingPolicy.MotionPoint toMotionPoint(LastPoint point) {
        if (point == null) {
            return null;
        }
        return new WalkRecordingPolicy.MotionPoint(
            point.latitude,
            point.longitude,
            point.timestamp,
            point.accuracy
        );
    }

    private static void requireMatchingSession(Session session, String expectedSessionId) {
        if (
            session != null &&
            expectedSessionId != null &&
            !expectedSessionId.isEmpty() &&
            !expectedSessionId.equals(session.sessionId)
        ) {
            throw new IllegalStateException("The requested walk does not match the active native session.");
        }
    }

    private static Session readSession(SQLiteDatabase db) {
        try (
            Cursor cursor = db.query(
                "session",
                new String[] {
                    "session_id",
                    "status",
                    "started_at",
                    "active_started_at",
                    "active_elapsed_ms",
                    "heartbeat_at",
                    "last_raw_fix_at",
                    "last_accepted_fix_at",
                    "ended_at",
                    "distance_m",
                    "force_segment",
                    "context_json"
                },
                null,
                null,
                null,
                null,
                null,
                "1"
            )
        ) {
            if (!cursor.moveToFirst()) {
                return null;
            }
            return new Session(
                cursor.getString(0),
                cursor.getString(1),
                cursor.getLong(2),
                cursor.getLong(3),
                cursor.getLong(4),
                cursor.getLong(5),
                cursor.getLong(6),
                cursor.getLong(7),
                cursor.getLong(8),
                cursor.getDouble(9),
                cursor.getInt(10) == 1,
                cursor.getString(11)
            );
        }
    }

    private static LastPoint readLastPoint(SQLiteDatabase db, String sessionId) {
        try (
            Cursor cursor = db.query(
                "points",
                new String[] { "latitude", "longitude", "accuracy", "timestamp", "starts_new_segment" },
                "session_id = ?",
                new String[] { sessionId },
                null,
                null,
                "row_id DESC",
                "1"
            )
        ) {
            if (!cursor.moveToFirst()) {
                return null;
            }
            return new LastPoint(
                cursor.getDouble(0),
                cursor.getDouble(1),
                cursor.getFloat(2),
                cursor.getLong(3),
                cursor.getInt(4) == 1
            );
        }
    }

    static double distanceMeters(double lat1, double lon1, double lat2, double lon2) {
        return WalkRecordingPolicy.distanceMeters(lat1, lon1, lat2, lon2);
    }

    static double bearingDegrees(double lat1, double lon1, double lat2, double lon2) {
        return WalkRecordingPolicy.bearingDegrees(lat1, lon1, lat2, lon2);
    }

    static final class LastPoint {
        final double latitude;
        final double longitude;
        final float accuracy;
        final long timestamp;
        final boolean startsNewSegment;

        LastPoint(double latitude, double longitude, float accuracy, long timestamp, boolean startsNewSegment) {
            this.latitude = latitude;
            this.longitude = longitude;
            this.accuracy = accuracy;
            this.timestamp = timestamp;
            this.startsNewSegment = startsNewSegment;
        }
    }

    private static final class Session {
        final String sessionId;
        final String status;
        final long startedAt;
        final long activeStartedAt;
        final long activeElapsedMs;
        final long heartbeatAt;
        final long lastRawFixAt;
        final long lastAcceptedFixAt;
        final long endedAt;
        final double distanceMeters;
        final boolean forceSegment;
        final String contextJson;

        Session(
            String sessionId,
            String status,
            long startedAt,
            long activeStartedAt,
            long activeElapsedMs,
            long heartbeatAt,
            long lastRawFixAt,
            long lastAcceptedFixAt,
            long endedAt,
            double distanceMeters,
            boolean forceSegment,
            String contextJson
        ) {
            this.sessionId = sessionId;
            this.status = status;
            this.startedAt = startedAt;
            this.activeStartedAt = activeStartedAt;
            this.activeElapsedMs = activeElapsedMs;
            this.heartbeatAt = heartbeatAt;
            this.lastRawFixAt = lastRawFixAt;
            this.lastAcceptedFixAt = lastAcceptedFixAt;
            this.endedAt = endedAt;
            this.distanceMeters = distanceMeters;
            this.forceSegment = forceSegment;
            this.contextJson = contextJson;
        }
    }
}
