package com.kubaberkowski.flaneur;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class WalkRecordingPolicyTest {
    @Test
    public void timestampPolicyRejectsPreSessionStaleAndFutureFixes() {
        long now = 1_000_000L;
        long startedAt = now - 30_000L;

        assertTrue(WalkRecordingPolicy.isFixTimestampUsable(now - 1_000L, startedAt, now));
        assertFalse(WalkRecordingPolicy.isFixTimestampUsable(startedAt - 1L, startedAt, now));
        assertFalse(
            WalkRecordingPolicy.isFixTimestampUsable(
                now - WalkRecordingPolicy.MAX_FIX_AGE_MS - 1L,
                now - 500_000L,
                now
            )
        );
        assertFalse(
            WalkRecordingPolicy.isFixTimestampUsable(
                now + WalkRecordingPolicy.MAX_FIX_FUTURE_SKEW_MS + 1L,
                startedAt,
                now
            )
        );

        long elapsedNanos = 1_000_000_000_000L;
        assertTrue(
            WalkRecordingPolicy.isElapsedRealtimeUsable(
                elapsedNanos - 1_000_000_000L,
                elapsedNanos
            )
        );
        assertFalse(
            WalkRecordingPolicy.isElapsedRealtimeUsable(
                elapsedNanos - (WalkRecordingPolicy.MAX_FIX_AGE_MS + 1L) * 1_000_000L,
                elapsedNanos
            )
        );
        assertFalse(
            WalkRecordingPolicy.isElapsedRealtimeUsable(
                elapsedNanos + (WalkRecordingPolicy.MAX_FIX_FUTURE_SKEW_MS + 1L) * 1_000_000L,
                elapsedNanos
            )
        );
    }

    @Test
    public void freshnessDistinguishesWaitingLiveAndLostSignal() {
        long now = 1_000_000L;
        assertEquals(
            WalkRecordingPolicy.FixFreshness.WAITING,
            WalkRecordingPolicy.fixFreshness(now, 0L, 0L)
        );
        assertEquals(
            WalkRecordingPolicy.FixFreshness.WAITING,
            WalkRecordingPolicy.fixFreshness(now, now - 1_000L, 0L)
        );
        assertEquals(
            WalkRecordingPolicy.FixFreshness.FRESH,
            WalkRecordingPolicy.fixFreshness(now, now - 1_000L, now - 20_000L)
        );
        assertEquals(
            WalkRecordingPolicy.FixFreshness.WAITING,
            WalkRecordingPolicy.fixFreshness(
                now,
                now - 1_000L,
                now - WalkRecordingPolicy.ACCEPTED_FIX_STALE_AFTER_MS - 1L
            )
        );
        assertEquals(
            WalkRecordingPolicy.FixFreshness.SIGNAL_LOST,
            WalkRecordingPolicy.fixFreshness(
                now,
                now - WalkRecordingPolicy.RAW_FIX_STALE_AFTER_MS - 1L,
                now - 60_000L
            )
        );
    }

    @Test
    public void sessionCommandsOnlyMatchTheirOwnNonEmptySession() {
        assertTrue(WalkRecordingPolicy.sessionMatches("walk-a", "walk-a"));
        assertFalse(WalkRecordingPolicy.sessionMatches("walk-a", "walk-b"));
        assertFalse(WalkRecordingPolicy.sessionMatches("walk-a", ""));
        assertFalse(WalkRecordingPolicy.sessionMatches(null, "walk-a"));
    }

    @Test
    public void motionGateEmitsWalkersAndNormalRunnersImmediately() {
        WalkRecordingPolicy.MotionGate gate = new WalkRecordingPolicy.MotionGate();
        gate.reset(null, true);

        WalkRecordingPolicy.MotionGateResult first = gate.accept(pointAtMeters(0d, 0L), 2f);
        WalkRecordingPolicy.MotionGateResult walker = gate.accept(pointAtMeters(8d, 4_000L), 2f);
        WalkRecordingPolicy.MotionGateResult runner = gate.accept(pointAtMeters(28d, 8_000L), 5f);

        assertEquals(1, first.emissions.size());
        assertTrue(first.emissions.get(0).startsNewSegment);
        assertEquals(1, walker.emissions.size());
        assertEquals(1, runner.emissions.size());
        assertFalse(gate.isVehicleMode());
        assertFalse(gate.hasBufferedFixes());
    }

    @Test
    public void motionGateReplaysAShortFastBurstWhenPedestrianPaceReturns() {
        WalkRecordingPolicy.MotionGate gate = seededGate();

        assertTrue(gate.accept(pointAtMeters(25d, 4_000L), 6.25f).buffered);
        assertTrue(gate.accept(pointAtMeters(50d, 8_000L), 6.25f).buffered);
        WalkRecordingPolicy.MotionGateResult replay = gate.accept(
            pointAtMeters(54d, 12_000L),
            1f
        );

        assertEquals(3, replay.emissions.size());
        assertEquals(25d, northMeters(replay.emissions.get(0).point), 0.25d);
        assertEquals(50d, northMeters(replay.emissions.get(1).point), 0.25d);
        assertEquals(54d, northMeters(replay.emissions.get(2).point), 0.25d);
        assertFalse(replay.vehicleMode);
        assertFalse(replay.buffered);
    }

    @Test
    public void motionGateDropsTheWholeFastBufferAfterSustainedVehicleMotion() {
        WalkRecordingPolicy.MotionGate gate = seededGate();

        assertTrue(gate.accept(pointAtMeters(25d, 4_000L), 6.25f).emissions.isEmpty());
        assertTrue(gate.accept(pointAtMeters(50d, 8_000L), 6.25f).emissions.isEmpty());
        WalkRecordingPolicy.MotionGateResult confirmed = gate.accept(
            pointAtMeters(75d, 12_000L),
            6.25f
        );

        assertTrue(confirmed.emissions.isEmpty());
        assertTrue(confirmed.vehicleMode);
        assertFalse(confirmed.buffered);
        assertTrue(gate.isVehicleMode());
    }

    @Test
    public void motionGateRequiresTenSlowSecondsThenStartsARecoverySegment() {
        WalkRecordingPolicy.MotionGate gate = vehicleGate();

        assertTrue(gate.accept(pointAtMeters(79d, 16_000L), 1f).emissions.isEmpty());
        assertTrue(gate.accept(pointAtMeters(85d, 22_000L), 1f).emissions.isEmpty());
        WalkRecordingPolicy.MotionGateResult recovered = gate.accept(
            pointAtMeters(91d, 28_000L),
            1f
        );

        assertFalse(recovered.vehicleMode);
        assertEquals(1, recovered.emissions.size());
        assertTrue(recovered.emissions.get(0).startsNewSegment);
        assertTrue(recovered.emissions.get(0).recovery);
    }

    @Test
    public void isolatedOutlierNeverBecomesTheNextMotionReference() {
        WalkRecordingPolicy.MotionGate gate = seededGate();
        assertEquals(1, gate.accept(pointAtMeters(8d, 4_000L), 2f).emissions.size());

        WalkRecordingPolicy.MotionGateResult outlier = gate.accept(
            pointAtMeters(1_000d, 8_000L),
            13f
        );
        WalkRecordingPolicy.MotionGateResult next = gate.accept(
            pointAtMeters(16d, 8_000L),
            2f
        );

        assertTrue(outlier.outlier);
        assertTrue(outlier.emissions.isEmpty());
        assertEquals(1, next.emissions.size());
        assertEquals(16d, northMeters(next.emissions.get(0).point), 0.25d);
    }

    @Test
    public void resetDropsUnclassifiedGeometryAndForcesANewSegment() {
        WalkRecordingPolicy.MotionGate gate = seededGate();
        gate.accept(pointAtMeters(25d, 4_000L), 6.25f);
        assertTrue(gate.hasBufferedFixes());

        gate.reset(pointAtMeters(0d, 0L), true);
        WalkRecordingPolicy.MotionGateResult afterReset = gate.accept(
            pointAtMeters(8d, 4_000L),
            2f
        );

        assertFalse(gate.hasBufferedFixes());
        assertEquals(1, afterReset.emissions.size());
        assertTrue(afterReset.emissions.get(0).startsNewSegment);
    }

    @Test
    public void radarSelectsNearestAcrossRouteAndCatalogueAndHonorsTieMetadata() {
        List<WalkRecordingPolicy.RadarCandidate> candidates = Arrays.asList(
            candidate("route-far", "Far route", 300d, true),
            candidate("near", "Nearest place", 50d, false),
            candidate("plain-tie", "Plain tie", 100d, false),
            candidate("route-tie", "Route tie", 100d, true)
        );
        List<WalkRecordingPolicy.RadarSelection> nearest = WalkRecordingPolicy.nearestCandidates(
            0d,
            0d,
            candidates,
            3
        );

        assertEquals(3, nearest.size());
        assertEquals("near", nearest.get(0).candidate.id);
        assertEquals("route-tie", nearest.get(1).candidate.id);
        assertEquals("plain-tie", nearest.get(2).candidate.id);
        assertTrue(nearest.get(1).candidate.isRouteStop);
        assertEquals(1, nearest.get(1).candidate.ordinal);
        assertEquals(100d, WalkRecordingPolicy.clampRadarRange(80d), 0d);
        List<WalkRecordingPolicy.RadarSelection> visible = WalkRecordingPolicy.withinRadarRange(
            nearest,
            80d,
            3
        );
        assertEquals(3, visible.size());
        assertEquals("near", visible.get(0).candidate.id);
        assertFalse(
            WalkRecordingPolicy.distanceMeters(0d, 0d, 300d / 111_195d, 0d) <=
            WalkRecordingPolicy.clampRadarRange(80d)
        );
    }

    @Test
    public void radarSafelySearchesTwoThousandCandidatesAndRendersOnlyThree() {
        List<WalkRecordingPolicy.RadarCandidate> candidates = new ArrayList<>();
        for (int index = 0; index < 2_000; index++) {
            candidates.add(candidate("place-" + index, "Place " + index, 4_000d - index, false));
        }
        List<WalkRecordingPolicy.RadarSelection> nearest = WalkRecordingPolicy.nearestCandidates(
            0d,
            0d,
            candidates,
            3
        );

        assertEquals(3, nearest.size());
        assertEquals("place-1999", nearest.get(0).candidate.id);
        assertEquals("place-1998", nearest.get(1).candidate.id);
        assertEquals("place-1997", nearest.get(2).candidate.id);
    }

    private static WalkRecordingPolicy.MotionGate seededGate() {
        WalkRecordingPolicy.MotionGate gate = new WalkRecordingPolicy.MotionGate();
        gate.reset(null, true);
        assertEquals(1, gate.accept(pointAtMeters(0d, 0L), 0f).emissions.size());
        return gate;
    }

    private static WalkRecordingPolicy.MotionGate vehicleGate() {
        WalkRecordingPolicy.MotionGate gate = seededGate();
        gate.accept(pointAtMeters(25d, 4_000L), 6.25f);
        gate.accept(pointAtMeters(50d, 8_000L), 6.25f);
        gate.accept(pointAtMeters(75d, 12_000L), 6.25f);
        assertTrue(gate.isVehicleMode());
        return gate;
    }

    private static WalkRecordingPolicy.MotionPoint pointAtMeters(double northMeters, long timestamp) {
        return new WalkRecordingPolicy.MotionPoint(northMeters / 111_195d, 0d, timestamp);
    }

    private static double northMeters(WalkRecordingPolicy.MotionPoint point) {
        return point.latitude * 111_195d;
    }

    private static WalkRecordingPolicy.RadarCandidate candidate(
        String id,
        String name,
        double northMeters,
        boolean routeStop
    ) {
        return new WalkRecordingPolicy.RadarCandidate(
            id,
            name,
            northMeters / 111_195d,
            0d,
            routeStop,
            routeStop ? 1 : 0
        );
    }
}
