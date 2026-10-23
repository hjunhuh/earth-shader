/** TS twin of src/shaders/common/noise.glsl (uint32 arithmetic via Math.imul). */

type V3 = [number, number, number]

export function pcg3d(x: number, y: number, z: number): V3 {
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0
  y = (Math.imul(y, 1664525) + 1013904223) >>> 0
  z = (Math.imul(z, 1664525) + 1013904223) >>> 0
  x = (x + Math.imul(y, z)) >>> 0
  y = (y + Math.imul(z, x)) >>> 0
  z = (z + Math.imul(x, y)) >>> 0
  x = (x ^ (x >>> 16)) >>> 0
  y = (y ^ (y >>> 16)) >>> 0
  z = (z ^ (z >>> 16)) >>> 0
  x = (x + Math.imul(y, z)) >>> 0
  y = (y + Math.imul(z, x)) >>> 0
  z = (z + Math.imul(x, y)) >>> 0
  return [x, y, z]
}

const wrap = (c: number, period: number) => ((c % period) + period) % period

export function hash33(cx: number, cy: number, cz: number, period: number, seed: number): V3 {
  const [hx, hy, hz] = pcg3d(
    (wrap(cx, period) + Math.imul(seed, 1013)) >>> 0,
    (wrap(cy, period) + Math.imul(seed, 7919)) >>> 0,
    (wrap(cz, period) + Math.imul(seed, 104729)) >>> 0,
  )
  return [(hx >>> 8) / 16777216, (hy >>> 8) / 16777216, (hz >>> 8) / 16777216]
}

const quintic = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

export function perlinNoise(px: number, py: number, pz: number, period: number, seed: number): number {
  const ix = Math.floor(px)
  const iy = Math.floor(py)
  const iz = Math.floor(pz)
  const fx = px - ix
  const fy = py - iy
  const fz = pz - iz
  const n: number[] = []
  for (let k = 0; k < 8; ++k) {
    const ox = k & 1
    const oy = (k >> 1) & 1
    const oz = (k >> 2) & 1
    const h = hash33(ix + ox, iy + oy, iz + oz, period, seed)
    let gx = h[0] * 2 - 1 + 1e-6
    let gy = h[1] * 2 - 1 + 1e-6
    let gz = h[2] * 2 - 1 + 1e-6
    const l = Math.hypot(gx, gy, gz)
    gx /= l
    gy /= l
    gz /= l
    n.push(gx * (fx - ox) + gy * (fy - oy) + gz * (fz - oz))
  }
  const ux = quintic(fx)
  const uy = quintic(fy)
  const uz = quintic(fz)
  const mix = (a: number, b: number, t: number) => a + (b - a) * t
  const x00 = mix(n[0]!, n[1]!, ux)
  const x10 = mix(n[2]!, n[3]!, ux)
  const x01 = mix(n[4]!, n[5]!, ux)
  const x11 = mix(n[6]!, n[7]!, ux)
  return mix(mix(x00, x10, uy), mix(x01, x11, uy), uz) * 1.7
}

export function worleyNoise(px: number, py: number, pz: number, period: number, seed: number): number {
  const ix = Math.floor(px)
  const iy = Math.floor(py)
  const iz = Math.floor(pz)
  const fx = px - ix
  const fy = py - iy
  const fz = pz - iz
  let d = 1e9
  for (let z = -1; z <= 1; ++z) {
    for (let y = -1; y <= 1; ++y) {
      for (let x = -1; x <= 1; ++x) {
        const h = hash33(ix + x, iy + y, iz + z, period, seed)
        const rx = x + h[0] - fx
        const ry = y + h[1] - fy
        const rz = z + h[2] - fz
        d = Math.min(d, rx * rx + ry * ry + rz * rz)
      }
    }
  }
  return Math.sqrt(d)
}
