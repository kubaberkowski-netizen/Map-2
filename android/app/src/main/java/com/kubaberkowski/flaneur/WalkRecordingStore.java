package com.kubaberkowski.flaneur;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.location.Location;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
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
    private static final int DATABASE_VERSION = 2;
    private static WalkRecordingStore instance;

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
    }

    synchronized JSObject start(String sessionId, long startedAt, JSONObject context) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Session current = readSession(db);
            if (current != null) {
                if (current.sessionId.equals(sessionId) && !STATUS_STOPPED.equals(current.status)) {
                    db.setTransactionSuccessful();
                    return snapshot(db, true);
                }
                throw new IllegalStateException("A native walk is still pending. Stop and acknowledge or discard it first.");
            }

            long now = System.currentTimeMillis();
            ContentValues values = new ContentValues();
            values.put("session_id", sessionId);
            values.put("status", STATUS_RECORDING);
            values.put("started_at", startedAt > 0 ? startedAt : now);
            values.put("active_started_at", now);
            values.put("active_elapsed_ms", 0L);
            values.put("heartbeat_at", now);
            values.put("ended_at", 0L);
            values.put("distance_m", 0d);
            values.put("force_segment", 1);
            values.put("context_json", context == null ? "{}" : context.toString());
            db.insertOrThrow("session", null, values);
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
                values.put("ended_at", 0L);
                values.put("force_segment", 1);
                db.update("session", values, "session_id = ?", new String[] { session.sessionId });
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

    /** Accepts a location only when it passes the same anti-jitter and walking-speed rules as web. */
    synchronized boolean record(Location location) {
        if (location == null || !location.hasAccuracy() || location.getAccuracy() <= 0 || location.getAccuracy() > 65f) {
            return false;
        }
        if (location.hasSpeed() && location.getSpeed() > 12f) {
            return false;
        }
        double latitude = location.getLatitude();
        double longitude = location.getLongitude();
        if (!Double.isFinite(latitude) || !Double.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
            return false;
        }

        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Session session = readSession(db);
            if (session == null || !STATUS_RECORDING.equals(session.status)) {
                return false;
            }

            long timestamp = location.getTime() > 0 ? location.getTime() : System.currentTimeMillis();
            LastPoint last = readLastPoint(db, session.sessionId);
            boolean startsNewSegment = last == null || session.forceSegment;
            double stepDistance = 0d;

            if (last != null) {
                long gapMs = timestamp - last.timestamp;
                if (gapMs <= 0) {
                    return false;
                }
                stepDistance = distanceMeters(last.latitude, last.longitude, latitude, longitude);
                double movementFloor = Math.max(12d, location.getAccuracy() / 2d);
                if (stepDistance < movementFloor) {
                    return false;
                }
                double calculatedSpeed = stepDistance / (gapMs / 1000d);
                if (calculatedSpeed > 12d) {
                    return false;
                }
                startsNewSegment = startsNewSegment || gapMs > 120_000L || (gapMs > 30_000L && stepDistance > 500d);
            }

            ContentValues point = new ContentValues();
            point.put("session_id", session.sessionId);
            point.put("latitude", latitude);
            point.put("longitude", longitude);
            point.put("accuracy", location.getAccuracy());
            point.put("timestamp", timestamp);
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

            ContentValues update = new ContentValues();
            update.put("force_segment", 0);
            update.put("heartbeat_at", System.currentTimeMillis());
            if (!startsNewSegment) {
                update.put("distance_m", session.distanceMeters + stepDistance);
            }
            db.update("session", update, "session_id = ?", new String[] { session.sessionId });
            db.setTransactionSuccessful();
            return true;
        } finally {
            db.endTransaction();
        }
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
        if (expectedSessionId == null || expectedSessionId.isEmpty()) {
            return false;
        }
        Session session = readSession(getReadableDatabase());
        return session != null && expectedSessionId.equals(session.sessionId);
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
                cursor.getDouble(7),
                cursor.getInt(8) == 1,
                cursor.getString(9)
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
        double earthRadius = 6_371_000d;
        double phi1 = Math.toRadians(lat1);
        double phi2 = Math.toRadians(lat2);
        double deltaPhi = Math.toRadians(lat2 - lat1);
        double deltaLambda = Math.toRadians(lon2 - lon1);
        double a =
            Math.sin(deltaPhi / 2d) * Math.sin(deltaPhi / 2d) +
            Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2d) * Math.sin(deltaLambda / 2d);
        return earthRadius * 2d * Math.atan2(Math.sqrt(a), Math.sqrt(1d - a));
    }

    static double bearingDegrees(double lat1, double lon1, double lat2, double lon2) {
        double phi1 = Math.toRadians(lat1);
        double phi2 = Math.toRadians(lat2);
        double lambda = Math.toRadians(lon2 - lon1);
        double y = Math.sin(lambda) * Math.cos(phi2);
        double x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda);
        return (Math.toDegrees(Math.atan2(y, x)) + 360d) % 360d;
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
            this.endedAt = endedAt;
            this.distanceMeters = distanceMeters;
            this.forceSegment = forceSegment;
            this.contextJson = contextJson;
        }
    }
}
