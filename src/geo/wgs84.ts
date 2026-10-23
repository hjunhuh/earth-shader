import { Vector3 } from 'three'

/** WGS84 semi-major axis [m]. */
export const WGS84_A = 6378137
/** WGS84 flattening. */
export const WGS84_F = 1 / 298.257223563
/** WGS84 semi-minor axis [m]. */
export const WGS84_B = WGS84_A * (1 - WGS84_F)
/** First eccentricity squared. */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F)

export const DEG = Math.PI / 180

export interface Geodetic {
  /** Longitude [rad]. */
  lon: number
  /** Geodetic latitude [rad]. */
  lat: number
  /** Height above the ellipsoid [m]. */
  height: number
}

const A2 = WGS84_A * WGS84_A
const B2 = WGS84_B * WGS84_B

/**
 * Geodetic -> ECEF in vector form: n = surface normal,
 * k = (a², a², b²) ⊙ n, p = k / sqrt(n·k) + h n.
 */
export function geodeticToEcef(lon: number, lat: number, height: number, out = new Vector3()): Vector3 {
  const cosLat = Math.cos(lat)
  const nx = cosLat * Math.cos(lon)
  const ny = cosLat * Math.sin(lon)
  const nz = Math.sin(lat)
  const kx = A2 * nx
  const ky = A2 * ny
  const kz = B2 * nz
  const gamma = Math.sqrt(nx * kx + ny * ky + nz * kz)
  return out.set(kx / gamma + height * nx, ky / gamma + height * ny, kz / gamma + height * nz)
}

export function geodeticDegToEcef(lonDeg: number, latDeg: number, height: number, out = new Vector3()): Vector3 {
  return geodeticToEcef(lonDeg * DEG, latDeg * DEG, height, out)
}

/** Unit ellipsoid normal for geodetic coordinates (also the local "up"). */
export function geodeticNormal(lon: number, lat: number, out = new Vector3()): Vector3 {
  const cosLat = Math.cos(lat)
  return out.set(cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat))
}

/** Unit normal of the ellipsoid surface passing through p (gradient direction). */
export function surfaceNormalAt(p: Vector3, out = new Vector3()): Vector3 {
  return out.set(p.x / A2, p.y / A2, p.z / B2).normalize()
}

const CENTER_TOLERANCE_SQUARED = 0.1

/**
 * Projects p onto the ellipsoid surface along the surface normal using
 * Newton iteration (Cesium's scaleToGeodeticSurface). Returns undefined near
 * the center where the projection is ill-defined.
 */
export function projectOnEllipsoid(p: Vector3, out = new Vector3()): Vector3 | undefined {
  const { x, y, z } = p
  const ox = 1 / WGS84_A
  const oz = 1 / WGS84_B
  const x2 = x * x * ox * ox
  const y2 = y * y * ox * ox
  const z2 = z * z * oz * oz
  const squaredNorm = x2 + y2 + z2
  const ratio = Math.sqrt(1 / squaredNorm)
  if (!Number.isFinite(ratio) || squaredNorm < CENTER_TOLERANCE_SQUARED) return undefined

  const ixx = x * ratio
  const iyy = y * ratio
  const izz = z * ratio
  const orx = 1 / A2
  const orz = 1 / B2
  const gx = ixx * orx * 2
  const gy = iyy * orx * 2
  const gz = izz * orz * 2
  let lambda = ((1 - ratio) * p.length()) / (0.5 * Math.hypot(gx, gy, gz))
  let correction = 0
  let func: number
  let xm: number
  let ym: number
  let zm: number
  let iterations = 0
  do {
    lambda -= correction
    xm = 1 / (1 + lambda * orx)
    ym = 1 / (1 + lambda * orx)
    zm = 1 / (1 + lambda * orz)
    const xm2 = xm * xm
    const ym2 = ym * ym
    const zm2 = zm * zm
    func = x2 * xm2 + y2 * ym2 + z2 * zm2 - 1
    const denominator = x2 * xm2 * xm * orx + y2 * ym2 * ym * orx + z2 * zm2 * zm * orz
    correction = func / (-2 * denominator)
  // |F| < 1e-12 still allows ~3 µm at Earth radius; iterate to float64 limits.
  } while (Math.abs(func) > 1e-15 && ++iterations < 64)
  return out.set(x * xm, y * ym, z * zm)
}

const scratchSurface = new Vector3()
const scratchNormal = new Vector3()

/** ECEF -> geodetic. Returns undefined near the center. */
export function ecefToGeodetic(p: Vector3): Geodetic | undefined {
  const s = projectOnEllipsoid(p, scratchSurface)
  if (s === undefined) return undefined
  const n = surfaceNormalAt(s, scratchNormal)
  const dx = p.x - s.x
  const dy = p.y - s.y
  const dz = p.z - s.z
  const h = Math.sign(dx * n.x + dy * n.y + dz * n.z) * Math.hypot(dx, dy, dz)
  // atan2 stays well-conditioned at the poles where asin(n.z) loses precision.
  return { lon: Math.atan2(n.y, n.x), lat: Math.atan2(n.z, Math.hypot(n.x, n.y)), height: h }
}

export interface EnuFrame {
  east: Vector3
  north: Vector3
  up: Vector3
}

/**
 * Local east-north-up frame. up = geodetic normal, east = (-sin λ, cos λ, 0)
 * (i.e. normalized (-y, x, 0)), north = up × east.
 */
export function enuFrame(lon: number, lat: number, out?: EnuFrame): EnuFrame {
  const frame = out ?? { east: new Vector3(), north: new Vector3(), up: new Vector3() }
  geodeticNormal(lon, lat, frame.up)
  frame.east.set(-Math.sin(lon), Math.cos(lon), 0)
  frame.north.crossVectors(frame.up, frame.east)
  return frame
}

/** Wraps longitude in degrees to [-180, 180). */
export function wrapLongitudeDeg(lon: number): number {
  if (lon >= -180 && lon < 180) return lon
  const w = (((lon + 180) % 360) + 360) % 360 - 180
  return Object.is(w, -0) ? 0 : w
}
