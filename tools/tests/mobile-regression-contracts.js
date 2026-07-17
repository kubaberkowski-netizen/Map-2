"use strict";

/**
 * Executable contracts for algorithms that are embedded in the minified app shell
 * or duplicated by the native recorders. These functions deliberately have no app
 * or platform dependencies, so edge cases can be exercised deterministically.
 *
 * They are a specification, not a second production implementation. When the
 * corresponding inline/native algorithm changes, keep its behaviour aligned with
 * these contracts and extend the scenarios in mobile-regressions.test.js.
 */

const EARTH_RADIUS_METERS = 6_371_000;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function elapsedSecondsForArchive(nativeSnapshot, routePoints, pausedMilliseconds = 0) {
  const nativeElapsedMilliseconds = nativeSnapshot && (
    nativeSnapshot.elapsedMs != null
      ? nativeSnapshot.elapsedMs
      : nativeSnapshot.elapsedMilliseconds
  );
  if (isFiniteNumber(nativeElapsedMilliseconds) && nativeElapsedMilliseconds >= 0) {
    return nativeElapsedMilliseconds / 1_000;
  }
  const nativeElapsed = nativeSnapshot && nativeSnapshot.elapsedSeconds;
  if (isFiniteNumber(nativeElapsed) && nativeElapsed >= 0) return nativeElapsed;

  if (!Array.isArray(routePoints) || routePoints.length < 2) return 0;
  const first = Number(routePoints[0].timestamp);
  const last = Number(routePoints[routePoints.length - 1].timestamp);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return Math.max(0, (last - first - Math.max(0, Number(pausedMilliseconds) || 0)) / 1_000);
}

function radians(degrees) {
  return degrees * Math.PI / 180;
}

function distanceMeters(a, b) {
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const deltaLat = lat2 - lat1;
  const deltaLng = radians(b.lng - a.lng);
  const h = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function projectMeters(point, origin) {
  const latitudeScale = Math.PI * EARTH_RADIUS_METERS / 180;
  return {
    x: (point.lng - origin.lng) * latitudeScale * Math.cos(radians(origin.lat)),
    y: (point.lat - origin.lat) * latitudeScale,
  };
}

function pointToSegmentMeters(point, start, end) {
  const p = projectMeters(point, start);
  const b = projectMeters(end, start);
  const lengthSquared = b.x * b.x + b.y * b.y;
  if (lengthSquared === 0) return Math.hypot(p.x, p.y);
  const amount = Math.max(0, Math.min(1, (p.x * b.x + p.y * b.y) / lengthSquared));
  return Math.hypot(p.x - amount * b.x, p.y - amount * b.y);
}

function pointToRouteMeters(point, route) {
  if (!Array.isArray(route) || route.length === 0) return Infinity;
  if (route.length === 1) return distanceMeters(point, route[0]);
  let closest = Infinity;
  for (let index = 1; index < route.length; index += 1) {
    closest = Math.min(closest, pointToSegmentMeters(point, route[index - 1], route[index]));
  }
  return closest;
}

/**
 * Radar hand-off contract:
 * - hand native the city's complete practical catalogue, rather than a starting
 *   nearest-24 snapshot that becomes stale while the WebView is suspended;
 * - if a very large catalogue must be bounded, prefer the current/route corridor;
 * - de-duplicate the payload deterministically.
 */
function selectRadarCandidates(spots, options) {
  const {
    currentLocation,
    route = [],
    maxCandidates = 2_000,
  } = options;
  if (!currentLocation || !Array.isArray(spots)) return [];

  const measured = spots
    .filter((spot) => spot && spot.id && isFiniteNumber(spot.lat) && isFiniteNumber(spot.lng))
    .map((spot) => ({
      spot,
      currentDistance: distanceMeters(currentLocation, spot),
      routeDistance: pointToRouteMeters(spot, route),
    }));

  const ranked = measured.sort((left, right) => {
    const leftScore = Math.min(left.currentDistance, left.routeDistance);
    const rightScore = Math.min(right.currentDistance, right.routeDistance);
    return leftScore - rightScore || left.currentDistance - right.currentDistance ||
      left.spot.id.localeCompare(right.spot.id);
  });

  const result = [];
  const seen = new Set();
  for (const candidate of ranked) {
    if (seen.has(candidate.spot.id)) continue;
    seen.add(candidate.spot.id);
    result.push(candidate.spot);
    if (result.length >= maxCandidates) break;
  }
  return result;
}

function isWorldMember(world, spot) {
  if (!world || !spot) return false;
  const predicateMatch = typeof world.match === "function" && Boolean(world.match(spot));
  const curatedMatch = Array.isArray(world.ids) && world.ids.includes(spot.id);
  return predicateMatch || curatedMatch;
}

function spotsForWorld(spots, world) {
  return spots.filter((spot) => isWorldMember(world, spot));
}

function setRouteDestination(discoveryState, destinationId) {
  return { ...discoveryState, destinationId };
}

function filterDiscoverySpots(spots, state, world) {
  const refinements = state.refinements || {};
  const categories = refinements.categories || [];
  return spots.filter((spot) => {
    if (state.cityId && spot.city !== state.cityId) return false;
    if (state.worldId && !isWorldMember(world, spot)) return false;
    if (state.savedOnly && !spot.saved) return false;
    if (categories.length && !categories.includes(spot.c)) return false;
    if (refinements.zone && spot.zone !== refinements.zone) return false;
    return true;
  });
}

/**
 * Platform-neutral walking recorder simulation. Coordinates are local metres rather
 * than latitude/longitude to make expected distances exact and test failures clear.
 */
function simulateLocationAcceptance(points, options = {}) {
  const maximumAccuracy = options.maximumAccuracy || 65;
  const maximumWalkingSpeed = options.maximumWalkingSpeed || 5;
  const minimumMovement = options.minimumMovement || 12;
  const sessionStartedAt = options.sessionStartedAt || 0;
  const accepted = [];
  let totalDistance = 0;
  let discontinuity = false;

  for (const point of points) {
    if (!point || !isFiniteNumber(point.x) || !isFiniteNumber(point.y) ||
        !isFiniteNumber(point.timestamp) || point.timestamp < sessionStartedAt ||
        !isFiniteNumber(point.accuracy) || point.accuracy <= 0 ||
        point.accuracy > maximumAccuracy) {
      continue;
    }
    if (isFiniteNumber(point.speed) && point.speed > maximumWalkingSpeed) {
      discontinuity = true;
      continue;
    }

    const previous = accepted[accepted.length - 1];
    if (!previous) {
      accepted.push({ ...point, startsNewSegment: false });
      discontinuity = false;
      continue;
    }

    const deltaSeconds = (point.timestamp - previous.timestamp) / 1_000;
    if (deltaSeconds <= 0) continue;
    const stepDistance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const movementFloor = Math.max(minimumMovement, point.accuracy / 2);
    if (stepDistance < movementFloor) continue;

    const calculatedSpeed = stepDistance / deltaSeconds;
    if (calculatedSpeed > maximumWalkingSpeed) {
      discontinuity = true;
      continue;
    }

    const startsNewSegment = discontinuity || deltaSeconds > 120 ||
      (deltaSeconds > 30 && stepDistance > 500);
    accepted.push({ ...point, startsNewSegment });
    if (!startsNewSegment) totalDistance += stepDistance;
    discontinuity = false;
  }

  return { accepted, totalDistance };
}

module.exports = {
  distanceMeters,
  elapsedSecondsForArchive,
  filterDiscoverySpots,
  isWorldMember,
  selectRadarCandidates,
  setRouteDestination,
  simulateLocationAcceptance,
  spotsForWorld,
};
