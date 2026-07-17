package com.kubaberkowski.flaneur;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/** Pure recording and radar policy shared by the Android service and local unit tests. */
final class WalkRecordingPolicy {
    static final long MAX_FIX_AGE_MS = 120_000L;
    static final long MAX_FIX_FUTURE_SKEW_MS = 5_000L;
    static final long RAW_FIX_STALE_AFTER_MS = 45_000L;
    static final long ACCEPTED_FIX_STALE_AFTER_MS = 90_000L;
    static final double MAX_INSTANTANEOUS_SPEED_MPS = 12d;
    static final double MOTORIZED_ROLLING_SPEED_MPS = 5.8d;
    static final int MOTORIZED_MIN_CONSECUTIVE_SEGMENTS = 3;
    static final long MOTORIZED_MIN_WINDOW_MS = 10_000L;
    static final double MOTORIZED_RECOVERY_SPEED_MPS = 4.5d;
    static final long MOTORIZED_RECOVERY_WINDOW_MS = 10_000L;

    private WalkRecordingPolicy() {}

    enum FixFreshness {
        WAITING,
        FRESH,
        SIGNAL_LOST
    }

    static boolean sessionMatches(String activeSessionId, String requestedSessionId) {
        return activeSessionId != null &&
            requestedSessionId != null &&
            !requestedSessionId.isEmpty() &&
            activeSessionId.equals(requestedSessionId);
    }

    static boolean isFixTimestampUsable(long fixAt, long sessionStartedAt, long receivedAt) {
        return fixAt > 0L &&
            fixAt >= sessionStartedAt &&
            fixAt >= receivedAt - MAX_FIX_AGE_MS &&
            fixAt <= receivedAt + MAX_FIX_FUTURE_SKEW_MS;
    }

    static boolean isElapsedRealtimeUsable(long fixNanos, long receivedNanos) {
        if (fixNanos <= 0L || receivedNanos <= 0L) {
            return false;
        }
        long maximumAgeNanos = MAX_FIX_AGE_MS * 1_000_000L;
        long maximumFutureSkewNanos = MAX_FIX_FUTURE_SKEW_MS * 1_000_000L;
        return fixNanos >= receivedNanos - maximumAgeNanos &&
            fixNanos <= receivedNanos + maximumFutureSkewNanos;
    }

    static FixFreshness fixFreshness(long now, long lastRawFixAt, long lastAcceptedFixAt) {
        if (lastRawFixAt <= 0L || lastRawFixAt > now + MAX_FIX_FUTURE_SKEW_MS) {
            return FixFreshness.WAITING;
        }
        if (now - lastRawFixAt > RAW_FIX_STALE_AFTER_MS) {
            return FixFreshness.SIGNAL_LOST;
        }
        if (
            lastAcceptedFixAt <= 0L ||
            lastAcceptedFixAt > now + MAX_FIX_FUTURE_SKEW_MS ||
            now - lastAcceptedFixAt > ACCEPTED_FIX_STALE_AFTER_MS
        ) {
            return FixFreshness.WAITING;
        }
        return FixFreshness.FRESH;
    }

    static double clampRadarRange(double rangeMeters) {
        if (!Double.isFinite(rangeMeters)) {
            return 800d;
        }
        return Math.min(5_000d, Math.max(100d, rangeMeters));
    }

    /**
     * Stateful pre-persistence gate. Fast fixes stay in memory until they are either
     * proved to be a short pedestrian burst or confirmed as motorized movement.
     * Nothing in the buffer, and no point observed in vehicle mode, is safe to write.
     */
    static final class MotionGate {
        private final List<MotionPoint> fastBuffer = new ArrayList<>();
        private MotionPoint trustedReference;
        private MotionPoint lastObservation;
        private long fastWindowStartedAt = -1L;
        private long recoveryStartedAt = -1L;
        private boolean vehicleMode;
        private boolean forceNextSegment = true;

        MotionGate() {}

        void reset(MotionPoint reference, boolean startNewSegment) {
            fastBuffer.clear();
            trustedReference = reference;
            lastObservation = reference;
            fastWindowStartedAt = -1L;
            recoveryStartedAt = -1L;
            vehicleMode = false;
            forceNextSegment = startNewSegment;
        }

        MotionGateResult accept(MotionPoint candidate, Float reportedSpeedMetersPerSecond) {
            if (
                candidate == null ||
                !validCoordinate(candidate.latitude, candidate.longitude) ||
                candidate.timestamp < 0L
            ) {
                return result(Collections.emptyList(), false);
            }

            MotionPoint reference = lastObservation != null ? lastObservation : trustedReference;
            if (reference != null && candidate.timestamp <= reference.timestamp) {
                return result(Collections.emptyList(), false);
            }
            if (reference == null) {
                return emitPedestrian(candidate, false);
            }

            double derivedSpeed = speedMetersPerSecond(reference, candidate);
            boolean hasReportedSpeed = reportedSpeedMetersPerSecond != null &&
                Float.isFinite(reportedSpeedMetersPerSecond) &&
                reportedSpeedMetersPerSecond >= 0f;
            double reportedSpeed = hasReportedSpeed
                ? reportedSpeedMetersPerSecond.doubleValue()
                : 0d;
            double speed = hasReportedSpeed
                ? Math.max(derivedSpeed, reportedSpeed)
                : derivedSpeed;

            if (!Double.isFinite(speed) || speed > MAX_INSTANTANEOUS_SPEED_MPS) {
                if (vehicleMode) {
                    recoveryStartedAt = -1L;
                }
                // An outlier never becomes a reference for the following fix.
                return result(Collections.emptyList(), true);
            }

            if (vehicleMode) {
                lastObservation = candidate;
                if (speed <= MOTORIZED_RECOVERY_SPEED_MPS) {
                    if (recoveryStartedAt < 0L) {
                        recoveryStartedAt = candidate.timestamp;
                    }
                    if (candidate.timestamp - recoveryStartedAt >= MOTORIZED_RECOVERY_WINDOW_MS) {
                        vehicleMode = false;
                        recoveryStartedAt = -1L;
                        forceNextSegment = true;
                        return emitPedestrian(candidate, true);
                    }
                } else {
                    recoveryStartedAt = -1L;
                }
                return result(Collections.emptyList(), false);
            }

            if (speed >= MOTORIZED_ROLLING_SPEED_MPS) {
                if (fastBuffer.isEmpty()) {
                    fastWindowStartedAt = reference.timestamp;
                }
                fastBuffer.add(candidate);
                lastObservation = candidate;
                if (
                    fastBuffer.size() >= MOTORIZED_MIN_CONSECUTIVE_SEGMENTS &&
                    candidate.timestamp - fastWindowStartedAt >= MOTORIZED_MIN_WINDOW_MS
                ) {
                    fastBuffer.clear();
                    fastWindowStartedAt = -1L;
                    recoveryStartedAt = -1L;
                    vehicleMode = true;
                    forceNextSegment = true;
                }
                return result(Collections.emptyList(), false);
            }

            return emitPedestrian(candidate, false);
        }

        boolean isVehicleMode() {
            return vehicleMode;
        }

        boolean hasBufferedFixes() {
            return !fastBuffer.isEmpty();
        }

        private MotionGateResult emitPedestrian(MotionPoint candidate, boolean recovery) {
            List<MotionEmission> emissions = new ArrayList<>(fastBuffer.size() + 1);
            boolean startsNewSegment = forceNextSegment || recovery;
            for (MotionPoint buffered : fastBuffer) {
                emissions.add(new MotionEmission(buffered, startsNewSegment, false));
                startsNewSegment = false;
            }
            emissions.add(new MotionEmission(candidate, startsNewSegment, recovery));

            fastBuffer.clear();
            fastWindowStartedAt = -1L;
            recoveryStartedAt = -1L;
            trustedReference = candidate;
            lastObservation = candidate;
            forceNextSegment = false;
            return result(emissions, false);
        }

        private MotionGateResult result(List<MotionEmission> emissions, boolean outlier) {
            return new MotionGateResult(
                emissions,
                vehicleMode,
                !fastBuffer.isEmpty(),
                outlier
            );
        }

        private static double speedMetersPerSecond(MotionPoint from, MotionPoint to) {
            long durationMs = to.timestamp - from.timestamp;
            if (durationMs <= 0L) {
                return Double.POSITIVE_INFINITY;
            }
            return distanceMeters(
                from.latitude,
                from.longitude,
                to.latitude,
                to.longitude
            ) / (durationMs / 1_000d);
        }
    }

    static final class MotionGateResult {
        final List<MotionEmission> emissions;
        final boolean vehicleMode;
        final boolean buffered;
        final boolean outlier;

        MotionGateResult(
            List<MotionEmission> emissions,
            boolean vehicleMode,
            boolean buffered,
            boolean outlier
        ) {
            this.emissions = emissions.isEmpty()
                ? Collections.emptyList()
                : Collections.unmodifiableList(new ArrayList<>(emissions));
            this.vehicleMode = vehicleMode;
            this.buffered = buffered;
            this.outlier = outlier;
        }
    }

    static final class MotionEmission {
        final MotionPoint point;
        final boolean startsNewSegment;
        final boolean recovery;

        MotionEmission(MotionPoint point, boolean startsNewSegment, boolean recovery) {
            this.point = point;
            this.startsNewSegment = startsNewSegment;
            this.recovery = recovery;
        }
    }

    static List<RadarSelection> nearestCandidates(
        double originLatitude,
        double originLongitude,
        List<RadarCandidate> candidates,
        int limit
    ) {
        if (candidates == null || candidates.isEmpty() || limit <= 0) {
            return Collections.emptyList();
        }
        List<RadarSelection> measured = new ArrayList<>(candidates.size());
        for (RadarCandidate candidate : candidates) {
            if (candidate == null || !validCoordinate(candidate.latitude, candidate.longitude)) {
                continue;
            }
            measured.add(
                new RadarSelection(
                    candidate,
                    distanceMeters(originLatitude, originLongitude, candidate.latitude, candidate.longitude),
                    bearingDegrees(originLatitude, originLongitude, candidate.latitude, candidate.longitude)
                )
            );
        }
        measured.sort(
            Comparator
                .comparingDouble((RadarSelection selection) -> selection.distanceMeters)
                .thenComparing(selection -> selection.candidate.isRouteStop ? 0 : 1)
                .thenComparing(selection -> selection.candidate.id)
        );
        if (measured.size() <= limit) {
            return measured;
        }
        return new ArrayList<>(measured.subList(0, limit));
    }

    static List<RadarSelection> withinRadarRange(
        List<RadarSelection> selections,
        double configuredRangeMeters,
        int limit
    ) {
        if (selections == null || selections.isEmpty() || limit <= 0) {
            return Collections.emptyList();
        }
        double rangeMeters = clampRadarRange(configuredRangeMeters);
        List<RadarSelection> visible = new ArrayList<>(Math.min(limit, selections.size()));
        for (RadarSelection selection : selections) {
            if (selection.distanceMeters <= rangeMeters) {
                visible.add(selection);
                if (visible.size() == limit) {
                    break;
                }
            }
        }
        return visible;
    }

    static boolean validCoordinate(double latitude, double longitude) {
        return Double.isFinite(latitude) &&
            Double.isFinite(longitude) &&
            Math.abs(latitude) <= 90d &&
            Math.abs(longitude) <= 180d;
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

    static final class MotionPoint {
        final double latitude;
        final double longitude;
        final long timestamp;
        final float accuracy;

        MotionPoint(double latitude, double longitude, long timestamp) {
            this(latitude, longitude, timestamp, Float.NaN);
        }

        MotionPoint(double latitude, double longitude, long timestamp, float accuracy) {
            this.latitude = latitude;
            this.longitude = longitude;
            this.timestamp = timestamp;
            this.accuracy = accuracy;
        }
    }

    static final class RadarCandidate {
        final String id;
        final String name;
        final double latitude;
        final double longitude;
        final boolean isRouteStop;
        final int ordinal;

        RadarCandidate(
            String id,
            String name,
            double latitude,
            double longitude,
            boolean isRouteStop,
            int ordinal
        ) {
            this.id = id == null ? "" : id;
            this.name = name;
            this.latitude = latitude;
            this.longitude = longitude;
            this.isRouteStop = isRouteStop;
            this.ordinal = ordinal;
        }
    }

    static final class RadarSelection {
        final RadarCandidate candidate;
        final double distanceMeters;
        final double bearingDegrees;

        RadarSelection(RadarCandidate candidate, double distanceMeters, double bearingDegrees) {
            this.candidate = candidate;
            this.distanceMeters = distanceMeters;
            this.bearingDegrees = bearingDegrees;
        }
    }
}
