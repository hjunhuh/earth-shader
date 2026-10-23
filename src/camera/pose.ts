import { Vector3 } from 'three'
import { DEG, ecefToGeodetic, enuFrame, geodeticToEcef, wrapLongitudeDeg, type EnuFrame } from '../geo/wgs84'

/** Camera state as exposed to the UI (degrees, meters). */
export interface GeoCameraState {
  lon: number
  lat: number
  /** Eye altitude above the WGS84 ellipsoid [m]. */
  alt: number
  /** Heading clockwise from north [deg, 0..360). */
  heading: number
  /** 0 = looking straight down, 90 = looking at the horizon [deg]. */
  tilt: number
}

/** Orthonormal camera pose in ECEF (float64). */
export interface CameraPose {
  position: Vector3
  forward: Vector3
  up: Vector3
}

export interface Viewport {
  width: number
  height: number
  /** Vertical field of view [deg]. */
  fovY: number
}

export const MIN_ALTITUDE = 50
export const MAX_ALTITUDE = 40_000_000
export const MAX_LATITUDE = 89.9

const mod360 = (x: number) => ((x % 360) + 360) % 360

/** Tilt limit shrinks with altitude: 88° below 100 km, 0° above 10,000 km (log-linear). */
export function maxTiltForAltitude(alt: number): number {
  const t = (Math.log10(Math.max(alt, 1)) - 5) / 2
  return 88 * (1 - Math.min(1, Math.max(0, t)))
}

export function clampState(s: GeoCameraState): GeoCameraState {
  const alt = Math.min(MAX_ALTITUDE, Math.max(MIN_ALTITUDE, s.alt))
  return {
    lon: wrapLongitudeDeg(s.lon),
    lat: Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, s.lat)),
    alt,
    heading: mod360(s.heading),
    tilt: Math.min(maxTiltForAltitude(alt), Math.max(0, s.tilt)),
  }
}

const frameScratch: EnuFrame = { east: new Vector3(), north: new Vector3(), up: new Vector3() }

export function stateToPose(s: GeoCameraState, out?: CameraPose): CameraPose {
  const pose = out ?? { position: new Vector3(), forward: new Vector3(), up: new Vector3() }
  const lon = s.lon * DEG
  const lat = s.lat * DEG
  geodeticToEcef(lon, lat, s.alt, pose.position)
  const { east, north, up } = enuFrame(lon, lat, frameScratch)
  const h = s.heading * DEG
  const t = s.tilt * DEG
  // Horizontal heading direction.
  const hx = north.x * Math.cos(h) + east.x * Math.sin(h)
  const hy = north.y * Math.cos(h) + east.y * Math.sin(h)
  const hz = north.z * Math.cos(h) + east.z * Math.sin(h)
  const ct = Math.cos(t)
  const st = Math.sin(t)
  pose.forward.set(-up.x * ct + hx * st, -up.y * ct + hy * st, -up.z * ct + hz * st).normalize()
  pose.up.set(hx * ct + up.x * st, hy * ct + up.y * st, hz * ct + up.z * st).normalize()
  return pose
}

/**
 * Derives the display state from a pose. Heading uses h = up·cos t + forward·sin t,
 * which equals the heading direction exactly for roll-free poses and stays
 * continuous through the nadir (where forward alone is degenerate).
 * Any roll in the pose is not represented (the pose stays canonical).
 */
export function poseToState(pose: CameraPose): GeoCameraState {
  const g = ecefToGeodetic(pose.position)
  if (g === undefined) throw new Error('Camera at planet center')
  const { east, north, up } = enuFrame(g.lon, g.lat, frameScratch)
  const f = pose.forward
  const cosT = Math.max(-1, Math.min(1, -f.dot(up)))
  const t = Math.acos(cosT)
  const sinT = Math.sin(t)
  const hx = pose.up.x * cosT + f.x * sinT
  const hy = pose.up.y * cosT + f.y * sinT
  const hz = pose.up.z * cosT + f.z * sinT
  const heading = Math.atan2(hx * east.x + hy * east.y + hz * east.z, hx * north.x + hy * north.y + hz * north.z) / DEG
  return {
    lon: wrapLongitudeDeg(g.lon / DEG),
    lat: g.lat / DEG,
    alt: g.height,
    heading: mod360(heading),
    tilt: t / DEG,
  }
}

/**
 * Roll [deg]: rotation of the camera up about forward away from the plane of
 * forward and the local vertical. 0 for poses built by stateToPose.
 * Undefined (returns 0) within 0.5° of nadir.
 */
export function poseRoll(pose: CameraPose): number {
  const g = ecefToGeodetic(pose.position)
  if (g === undefined) return 0
  const up = enuFrame(g.lon, g.lat, frameScratch).up
  const f = pose.forward
  const level = new Vector3().copy(up).addScaledVector(f, -up.dot(f))
  if (level.length() < Math.sin(0.5 * DEG)) return 0
  level.normalize()
  const right = new Vector3().crossVectors(f, pose.up)
  return Math.atan2(-level.dot(right), level.dot(pose.up)) / DEG
}

export function poseRight(pose: CameraPose, out = new Vector3()): Vector3 {
  return out.crossVectors(pose.forward, pose.up).normalize()
}

/** Direction through normalized device coordinates (x, y ∈ [-1, 1], +y up). */
export function rayDirection(pose: CameraPose, vp: Viewport, ndcX: number, ndcY: number, out = new Vector3()): Vector3 {
  const tanY = Math.tan((vp.fovY * DEG) / 2)
  const tanX = tanY * (vp.width / vp.height)
  const right = poseRight(pose, scratchRight)
  return out
    .copy(pose.forward)
    .addScaledVector(right, ndcX * tanX)
    .addScaledVector(pose.up, ndcY * tanY)
    .normalize()
}

const scratchRight = new Vector3()
const scratchRel = new Vector3()

/** Projects an ECEF point to NDC. `behind` is true when it is behind the camera. */
export function projectToNdc(pose: CameraPose, vp: Viewport, p: Vector3): { x: number; y: number; behind: boolean } {
  const rel = scratchRel.subVectors(p, pose.position)
  const z = rel.dot(pose.forward)
  const right = poseRight(pose, scratchRight)
  const tanY = Math.tan((vp.fovY * DEG) / 2)
  const tanX = tanY * (vp.width / vp.height)
  return { x: rel.dot(right) / (z * tanX), y: rel.dot(pose.up) / (z * tanY), behind: z <= 0 }
}

export function ndcToPixels(vp: Viewport, x: number, y: number): { px: number; py: number } {
  return { px: ((x + 1) / 2) * vp.width, py: ((1 - y) / 2) * vp.height }
}

export function pixelsToNdc(vp: Viewport, px: number, py: number): { x: number; y: number } {
  return { x: (px / vp.width) * 2 - 1, y: 1 - (py / vp.height) * 2 }
}

export function clonePose(p: CameraPose): CameraPose {
  return { position: p.position.clone(), forward: p.forward.clone(), up: p.up.clone() }
}
