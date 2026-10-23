import type { Vec3 } from '../../../src/atmosphere/constants'

/** Emulates GL bilinear filtering (texel centers at (i+0.5)/size, clamp-to-edge) on RGBA data. */
export function sampleBilinear(data: Float32Array, width: number, height: number, u: number, v: number): Vec3 {
  const x = Math.min(width - 1, Math.max(0, u * width - 0.5))
  const y = Math.min(height - 1, Math.max(0, v * height - 0.5))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const at = (xx: number, yy: number, c: number) => data[(yy * width + xx) * 4 + c]!
  const out: Vec3 = [0, 0, 0]
  for (let c = 0; c < 3; ++c) {
    const a = at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx
    const b = at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx
    out[c] = a * (1 - fy) + b * fy
  }
  return out
}

export function maxRelErr(a: Vec3, b: Vec3, floor = 1e-12): number {
  return Math.max(...[0, 1, 2].map((i) => Math.abs(a[i]! - b[i]!) / Math.max(Math.abs(b[i]!), floor)))
}
