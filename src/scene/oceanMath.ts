/**
 * Ray–ellipsoid intersection for the ocean surface (WGS84, height 0).
 *
 * The ellipsoid is mapped to a sphere of radius a by S = diag(1, 1, a/b).
 * S is affine, so the ray parameter t (meters along a unit world direction)
 * is preserved. The quadratic's constant term c = |S·o|² − a² is formed on
 * the CPU in float64 as (|S·o| − a)(|S·o| + a); in float32 the naive form
 * loses all precision near the surface.
 */

export const WGS84_A = 6378137
export const WGS84_B = 6356752.314245179
export const Z_SCALE = WGS84_A / WGS84_B

export type Vec3 = readonly [number, number, number]

export function toShading(p: Vec3): [number, number, number] {
  return [p[0], p[1], p[2] * Z_SCALE]
}

/** c = |S·o|² − a², stable in float64 (and as a float32 uniform). */
export function oceanCTerm(cameraEcef: Vec3): number {
  const s = toShading(cameraEcef)
  const r = Math.hypot(s[0], s[1], s[2])
  return (r - WGS84_A) * (r + WGS84_A)
}

const fround = Math.fround

/**
 * Distance along the unit world direction `dir` to the ocean surface, or null
 * if the ray misses. `float32` emulates the shader's arithmetic.
 */
export function intersectOcean(origin: Vec3, dir: Vec3, c = oceanCTerm(origin), float32 = false): number | null {
  const f = float32 ? fround : (x: number) => x
  const o = toShading(origin).map(f)
  const d = toShading(dir).map(f)
  const A = f(f(d[0]! * d[0]!) + f(d[1]! * d[1]!) + f(d[2]! * d[2]!))
  const B = f(f(o[0]! * d[0]!) + f(o[1]! * d[1]!) + f(o[2]! * d[2]!))
  const C = f(c)
  const disc = f(f(B * B) - f(A * C))
  if (disc < 0) return null
  const s = f(Math.sqrt(disc))
  if (C > 0) {
    if (B >= 0) return null
    return f(C / f(s - B)) // near root, cancellation-free
  }
  return f(f(s - B) / A) // camera below the surface: far root
}

/** Textbook form with c computed in the working precision (for comparison). */
export function intersectOceanNaive(origin: Vec3, dir: Vec3, float32 = false): number | null {
  const f = float32 ? fround : (x: number) => x
  const o = toShading(origin).map(f)
  const d = toShading(dir).map(f)
  const A = f(f(d[0]! * d[0]!) + f(d[1]! * d[1]!) + f(d[2]! * d[2]!))
  const B = f(f(o[0]! * d[0]!) + f(o[1]! * d[1]!) + f(o[2]! * d[2]!))
  const C = f(f(f(o[0]! * o[0]!) + f(o[1]! * o[1]!) + f(o[2]! * o[2]!)) - f(WGS84_A * WGS84_A))
  const disc = f(f(B * B) - f(A * C))
  if (disc < 0) return null
  const t = f(f(-B - f(Math.sqrt(disc))) / A)
  return t > 0 ? t : null
}

/** Distance from a point at altitude h to the geometric horizon of a sphere of radius a. */
export function horizonDistance(h: number, radius = WGS84_A): number {
  return Math.sqrt(Math.max(0, h * (2 * radius + h)))
}

/**
 * Near/far planes. At the story's altitudes the ocean's horizon is within its
 * far plane (4e5 m), so near/far stay exactly 1 / 4e5 there. Higher up, far
 * grows to keep the whole visible ocean in the depth range and near scales
 * with altitude to keep depth precision.
 */
export function clipPlanes(altitude: number, base = { near: 1, far: 4e5 }): { near: number; far: number } {
  const needed = 1.2 * horizonDistance(Math.max(0, altitude))
  if (needed <= base.far) return { near: base.near, far: base.far }
  return { near: Math.max(base.near, altitude * 0.01), far: needed }
}
