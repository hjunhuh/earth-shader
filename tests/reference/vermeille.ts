/**
 * Independent ECEF -> geodetic conversion (Vermeille 2011, closed form),
 * used only to cross-check the Newton projection in src/geo/wgs84.ts.
 * Valid outside the evolute region near the center.
 */
const A = 6378137
const F = 1 / 298.257223563
const E2 = F * (2 - F)
const E4 = E2 * E2

export function vermeilleEcefToGeodetic(x: number, y: number, z: number): { lon: number; lat: number; height: number } {
  const p = (x * x + y * y) / (A * A)
  const q = ((1 - E2) / (A * A)) * z * z
  const r = (p + q - E4) / 6
  const s = (E4 * p * q) / (4 * r * r * r)
  const t = Math.cbrt(1 + s + Math.sqrt(s * (2 + s)))
  const u = r * (1 + t + 1 / t)
  const v = Math.sqrt(u * u + E4 * q)
  const w = (E2 * (u + v - q)) / (2 * v)
  const k = Math.sqrt(u + v + w * w) - w
  const rho = Math.hypot(x, y)
  const D = (k * rho) / (k + E2)
  const dz = Math.hypot(D, z)
  const lat = 2 * Math.atan2(z, D + dz)
  const height = ((k + E2 - 1) / k) * dz
  return { lon: Math.atan2(y, x), lat, height }
}
