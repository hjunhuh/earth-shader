import { Quaternion, Vector3 } from 'three'
import { pickEllipsoid, raySphereStable } from '../geo/intersect'
import { ecefToGeodetic, geodeticToEcef, surfaceNormalAt } from '../geo/wgs84'
import { sphereCTerm } from '../geo/shadingSpace'
import {
  clonePose,
  maxTiltForAltitude,
  poseRight,
  poseToState,
  rayDirection,
  stateToPose,
  MAX_ALTITUDE,
  MIN_ALTITUDE,
  type CameraPose,
  type Viewport,
} from './pose'

/**
 * Google-Earth-style camera operations as pure functions on CameraPose.
 * The pose (full orientation) is canonical; {lon, lat, alt, heading, tilt}
 * is derived for display. The DOM layer (GlobeControls) only maps events.
 */

const q = new Quaternion()
const v0 = new Vector3()
const v1 = new Vector3()
const v2 = new Vector3()

function rotatePose(pose: CameraPose, rotation: Quaternion, pivot?: Vector3): void {
  if (pivot) pose.position.sub(pivot)
  pose.position.applyQuaternion(rotation)
  if (pivot) pose.position.add(pivot)
  pose.forward.applyQuaternion(rotation).normalize()
  pose.up.applyQuaternion(rotation).normalize()
}

/** Moves the pose along its geodetic normal to a given height, keeping orientation. */
function setHeight(pose: CameraPose, height: number): void {
  const g = ecefToGeodetic(pose.position)
  if (g === undefined) return
  geodeticToEcef(g.lon, g.lat, height, pose.position)
}

export function poseAltitude(pose: CameraPose): number {
  return ecefToGeodetic(pose.position)?.height ?? 0
}

/** Ellipsoid point under NDC, or null when the ray misses the globe. */
export function pickAt(pose: CameraPose, vp: Viewport, ndcX: number, ndcY: number): Vector3 | null {
  return pickEllipsoid(pose.position, rayDirection(pose, vp, ndcX, ndcY))
}

/**
 * Point on the camera ray at distance |grab| from the planet center. Falls
 * back to the closest approach (scaled to that radius) when the ray misses,
 * so dragging past the limb keeps rotating the globe.
 */
function pointOnRayAtRadius(origin: Vector3, dir: Vector3, radius: number, out: Vector3): Vector3 {
  const hit = raySphereStable(origin.dot(dir), sphereCTerm(origin.length(), radius))
  if (hit !== null && hit.near > 0) return out.copy(origin).addScaledVector(dir, hit.near)
  const t = Math.max(0, -origin.dot(dir))
  out.copy(origin).addScaledVector(dir, t)
  return out.setLength(radius)
}

/**
 * Grab-pan: rotates the camera about the planet center so that the grabbed
 * ECEF point lies under the cursor. With R = rotation(target → grab),
 * grab − R·cam = R(target − cam) lies on the rotated cursor ray, so the
 * point is exact; the geodetic altitude is then restored (sub-pixel shift).
 */
export function panPose(pose: CameraPose, vp: Viewport, grab: Vector3, ndcX: number, ndcY: number): CameraPose {
  const next = clonePose(pose)
  const height = poseAltitude(pose)
  const dir = rayDirection(next, vp, ndcX, ndcY)
  const target = pointOnRayAtRadius(next.position, dir, grab.length(), v0)
  q.setFromUnitVectors(v1.copy(target).normalize(), v2.copy(grab).normalize())
  rotatePose(next, q)
  setHeight(next, height)
  return next
}

/**
 * Zoom toward the cursor: moves the camera along the cursor ray so the
 * point under the cursor stays fixed. factor < 1 zooms in.
 */
export function zoomPose(pose: CameraPose, vp: Viewport, ndcX: number, ndcY: number, factor: number): CameraPose {
  const next = clonePose(pose)
  const dir = rayDirection(next, vp, ndcX, ndcY)
  const hit = pickEllipsoid(next.position, dir)
  const height = poseAltitude(pose)
  if (hit === null) {
    setHeight(next, Math.min(MAX_ALTITUDE, Math.max(MIN_ALTITUDE, height * factor)))
    return next
  }
  const distance = hit.distanceTo(next.position)
  next.position.addScaledVector(dir, distance * (1 - factor))
  const h = poseAltitude(next)
  if (h < MIN_ALTITUDE || h > MAX_ALTITUDE) {
    // Stop at the altitude limit along the same ray (keeps the cursor point fixed).
    const limit = h < MIN_ALTITUDE ? MIN_ALTITUDE : MAX_ALTITUDE
    let lo = 0
    let hi = distance * (1 - factor)
    for (let i = 0; i < 60; ++i) {
      const mid = (lo + hi) / 2
      v0.copy(pose.position).addScaledVector(dir, mid)
      const hm = ecefToGeodetic(v0)?.height ?? 0
      if ((h < MIN_ALTITUDE && hm >= limit) || (h > MAX_ALTITUDE && hm <= limit)) lo = mid
      else hi = mid
    }
    next.position.copy(pose.position).addScaledVector(dir, lo)
  }
  return next
}

/**
 * Orbit around the pivot under the screen center: heading rotates about the
 * pivot normal, tilt about the camera right axis through the pivot. The
 * tilt part is rejected if it exceeds the altitude-dependent limit or goes
 * underground. The result is roll-free (orbiting levels the horizon).
 */
export function orbitPose(pose: CameraPose, vp: Viewport, deltaHeadingDeg: number, deltaTiltDeg: number): CameraPose {
  void vp
  let next = clonePose(pose)
  const pivot = pickEllipsoid(next.position, next.forward)
  if (pivot === null) {
    const s = poseToState(next)
    s.heading += deltaHeadingDeg
    s.tilt = Math.min(maxTiltForAltitude(s.alt), Math.max(0, s.tilt + deltaTiltDeg))
    return stateToPose(s)
  }
  const normal = surfaceNormalAt(pivot, new Vector3())
  q.setFromAxisAngle(normal, (-deltaHeadingDeg * Math.PI) / 180)
  rotatePose(next, q, pivot)
  // Tilt about the pivot: clamp so the pivot tilt stays in [0, limit] (stops at nadir).
  const toCam0 = v0.subVectors(next.position, pivot).normalize()
  const pivotTilt0 = (Math.acos(Math.max(-1, Math.min(1, toCam0.dot(normal)))) * 180) / Math.PI
  const limit = maxTiltForAltitude(poseAltitude(next))
  const delta = Math.min(limit - pivotTilt0, Math.max(-pivotTilt0, deltaTiltDeg))
  if (delta !== 0) {
    const candidate = clonePose(next)
    q.setFromAxisAngle(poseRight(candidate, new Vector3()), (delta * Math.PI) / 180)
    rotatePose(candidate, q, pivot)
    const alt = poseAltitude(candidate)
    const toCam = v0.subVectors(candidate.position, pivot)
    if (alt >= MIN_ALTITUDE && toCam.dot(normal) > 0) next = candidate
  }
  return levelPose(next)
}

/**
 * Removes roll: the camera up is re-projected into the plane spanned by
 * forward and the local vertical. Forward is kept exactly. Near nadir the
 * plane is degenerate and the pose is returned unchanged.
 */
export function levelPose(pose: CameraPose): CameraPose {
  const out = clonePose(pose)
  const g = ecefToGeodetic(pose.position)
  if (g === undefined) return out
  const up = surfaceNormalAt(pose.position, v1)
  const f = pose.forward
  const proj = v2.copy(up).addScaledVector(f, -up.dot(f))
  if (proj.length() < Math.sin((0.5 * Math.PI) / 180)) return out
  out.up.copy(proj.normalize())
  return out
}

/** Flies a fraction of the way between two poses (geodetic interpolation, log altitude). */
export function interpolatePose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  const sa = poseToState(a)
  const sb = poseToState(b)
  let dLon = sb.lon - sa.lon
  if (dLon > 180) dLon -= 360
  if (dLon < -180) dLon += 360
  let dHead = sb.heading - sa.heading
  if (dHead > 180) dHead -= 360
  if (dHead < -180) dHead += 360
  const e = t * t * (3 - 2 * t)
  const logAlt = Math.log(sa.alt) * (1 - e) + Math.log(sb.alt) * e
  return stateToPose({
    lon: sa.lon + dLon * e,
    lat: sa.lat + (sb.lat - sa.lat) * e,
    alt: Math.exp(logAlt),
    heading: sa.heading + dHead * e,
    tilt: sa.tilt + (sb.tilt - sa.tilt) * e,
  })
}
