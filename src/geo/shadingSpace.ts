import { Vector3 } from 'three'
import { WGS84_A, WGS84_B } from './wgs84'

/**
 * Shading space: the linear map M = diag(1, 1, a/b) turns the WGS84
 * ellipsoid into a sphere of radius a. Because M is linear, rays stay
 * straight, so the ocean, cloud shells (spheres of radius a + h) and the
 * spherical atmosphere stay consistent everywhere, including the limb.
 */
export const SHADING_Z_SCALE = WGS84_A / WGS84_B
/** Radius of the ocean sphere in shading space [m]. */
export const SHADING_EARTH_RADIUS = WGS84_A

export function ecefToShading(p: Vector3, out = new Vector3()): Vector3 {
  return out.set(p.x, p.y, p.z * SHADING_Z_SCALE)
}

export function shadingToEcef(p: Vector3, out = new Vector3()): Vector3 {
  return out.set(p.x, p.y, p.z / SHADING_Z_SCALE)
}

/** Transforms a direction (e.g. ray or sun direction) by M and normalizes. */
export function directionToShading(d: Vector3, out = new Vector3()): Vector3 {
  return out.set(d.x, d.y, d.z * SHADING_Z_SCALE).normalize()
}

export function directionToEcef(d: Vector3, out = new Vector3()): Vector3 {
  return out.set(d.x, d.y, d.z / SHADING_Z_SCALE).normalize()
}

/** Normals transform by M^-T = diag(1, 1, b/a). */
export function normalToShading(n: Vector3, out = new Vector3()): Vector3 {
  return out.set(n.x, n.y, n.z / SHADING_Z_SCALE).normalize()
}

/** Shading-space height above the ocean sphere (≈ geodetic height, ≤0.34% error). */
export function shadingHeight(pShading: Vector3): number {
  return pShading.length() - SHADING_EARTH_RADIUS
}

/**
 * c = |o|² − R² computed as (|o| − R)(|o| + R) in float64, so the GPU can
 * solve ray–sphere quadratics without catastrophic cancellation.
 */
export function sphereCTerm(originLength: number, radius: number): number {
  return (originLength - radius) * (originLength + radius)
}
