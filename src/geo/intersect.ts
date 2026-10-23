import { Vector3 } from 'three'
import { SHADING_EARTH_RADIUS, ecefToShading, shadingToEcef, sphereCTerm } from './shadingSpace'

export interface RayHit {
  /** Near root (may be negative when the origin is inside). */
  near: number
  /** Far root. */
  far: number
}

/**
 * Ray from the origin of a camera-relative frame against a sphere centered
 * at -o (i.e. the planet center when the camera sits at o). Uses the
 * numerically stable form with a precomputed c-term:
 *   t² + 2 b t + c = 0, b = o·d, c = |o|² − R² = (|o|−R)(|o|+R).
 * Mirrors raySphereStable() in shaders/common/intersect.glsl.
 */
export function raySphereStable(b: number, c: number): RayHit | null {
  const disc = b * b - c
  if (disc < 0) return null
  const s = Math.sqrt(disc)
  const q = b > 0 ? -b - s : -b + s
  if (q === 0) return { near: 0, far: 0 }
  const t0 = q
  const t1 = c / q
  return t0 < t1 ? { near: t0, far: t1 } : { near: t1, far: t0 }
}

/** Naive textbook form, used only to demonstrate the precision gap in tests. */
export function raySphereNaive(o: Vector3, d: Vector3, radius: number): RayHit | null {
  const b = o.dot(d)
  const c = o.dot(o) - radius * radius
  const disc = b * b - c
  if (disc < 0) return null
  const s = Math.sqrt(disc)
  return { near: -b - s, far: -b + s }
}

const so = new Vector3()
const sd = new Vector3()

/**
 * Intersects an ECEF ray with the ellipsoid inflated by `height` (exact for
 * height 0; ≤0.34% height distortion otherwise) via shading space.
 * Returns the ECEF hit point of the nearest positive root, or null.
 */
export function pickEllipsoid(
  origin: Vector3,
  direction: Vector3,
  height = 0,
  out = new Vector3(),
): Vector3 | null {
  ecefToShading(origin, so)
  ecefToShading(direction, sd) // linear map of the direction (not normalized)
  const dl = sd.length()
  sd.divideScalar(dl)
  const radius = SHADING_EARTH_RADIUS + height
  const hit = raySphereStable(so.dot(sd), sphereCTerm(so.length(), radius))
  if (hit === null) return null
  const t = hit.near >= 0 ? hit.near : hit.far >= 0 ? hit.far : -1
  if (t < 0) return null
  so.addScaledVector(sd, t)
  return shadingToEcef(so, out)
}

/** Closest point on a ray to the planet center, in ECEF. */
export function closestPointToCenter(origin: Vector3, direction: Vector3, out = new Vector3()): Vector3 {
  const t = Math.max(0, -origin.dot(direction) / direction.lengthSq())
  return out.copy(origin).addScaledVector(direction, t)
}

