import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { CloudResources } from '../../../src/clouds/CloudResources'
import { ReadbackPass } from '../../../src/render/ReadbackPass'
import { captureShaderErrors, createTestRenderer, disposeTestRenderer } from '../harness/context'

const renderer = createTestRenderer(64, 64)
const errors = captureShaderErrors(renderer)
const readback = new ReadbackPass()
const SIZE = 256
let res: CloudResources
const faces: Float32Array[] = []

/** Equi-angular face texel -> direction (TS twin of common/cubemap.glsl). */
function faceDirection(face: number, x: number, y: number): Vector3 {
  const w = [((x + 0.5) / SIZE) * 2 - 1, ((y + 0.5) / SIZE) * 2 - 1]
  const [sc, tc] = w.map((v) => Math.tan((v * Math.PI) / 4)) as [number, number]
  const d = [
    [1, -tc, -sc],
    [-1, -tc, sc],
    [sc, 1, tc],
    [sc, -1, -tc],
    [sc, -tc, 1],
    [-sc, -tc, -1],
  ][face]!
  return new Vector3(d[0], d[1], d[2]).normalize()
}

beforeAll(() => {
  res = new CloudResources(renderer, { weatherSize: SIZE, sunOpticalDepthSize: 64 })
  res.bakeStatic(1)
  for (let f = 0; f < 6; ++f) faces.push(readback.readCubeFace(renderer, res.weather.texture, SIZE, f))
})

afterAll(() => {
  res.dispose()
  readback.dispose()
  disposeTestRenderer(renderer)
})

describe('weather cubemap', () => {
  it('bakes without shader errors and stays in [0, 1]', () => {
    expect(errors.errors).toEqual([])
    for (const f of faces) for (let i = 0; i < f.length; ++i) {
      expect(f[i]!).toBeGreaterThanOrEqual(0)
      expect(f[i]!).toBeLessThanOrEqual(1)
    }
  })

  it('is continuous across cube face seams (seam jumps ≈ interior neighbor differences)', () => {
    // Sample the field by direction on both sides of each face edge.
    const sample = (d: Vector3, c: number) => {
      const a = [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)]
      let face: number
      let sc: number
      let tc: number
      if (a[0]! >= a[1]! && a[0]! >= a[2]!) {
        face = d.x > 0 ? 0 : 1
        sc = d.x > 0 ? -d.z / a[0]! : d.z / a[0]!
        tc = -d.y / a[0]!
      } else if (a[1]! >= a[2]!) {
        face = d.y > 0 ? 2 : 3
        sc = d.x / a[1]!
        tc = d.y > 0 ? d.z / a[1]! : -d.z / a[1]!
      } else {
        face = d.z > 0 ? 4 : 5
        sc = d.z > 0 ? d.x / a[2]! : -d.x / a[2]!
        tc = -d.y / a[2]!
      }
      const wx = (Math.atan(sc) / (Math.PI / 4) + 1) / 2
      const wy = (Math.atan(tc) / (Math.PI / 4) + 1) / 2
      const x = Math.min(SIZE - 1, Math.floor(wx * SIZE))
      const y = Math.min(SIZE - 1, Math.floor(wy * SIZE))
      return faces[face]![(y * SIZE + x) * 4 + c]!
    }
    let seam = 0
    let interior = 0
    let n = 0
    const eps = (1.5 / SIZE) * (Math.PI / 2)
    for (let i = 0; i < 2000; ++i) {
      // Points just across a seam: x = y edge on face boundaries.
      const t = (i / 2000) * 2 - 1
      const onEdge = new Vector3(1, t, 1).normalize() // +X / +Z boundary
      const side = new Vector3(-1, 0, 1).normalize()
      const a = onEdge.clone().addScaledVector(side, eps).normalize()
      const b = onEdge.clone().addScaledVector(side, -eps).normalize()
      const c = a.clone().addScaledVector(side, 2 * eps).normalize()
      seam += Math.abs(sample(a, 0) - sample(b, 0))
      interior += Math.abs(sample(c, 0) - sample(a, 0))
      n++
    }
    expect(seam / n).toBeLessThan(2 * (interior / n) + 1e-3)
  })

  it('reproduces the climatology: ITCZ and storm tracks cloudier than the subtropical highs', () => {
    const zonal = (latDeg: number) => {
      let s = 0
      for (let k = 0; k < 360; ++k) {
        const lat = (latDeg * Math.PI) / 180
        const lon = (k * Math.PI) / 180
        const d = new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat))
        // nearest texel via the face projection used above
        let best = 0
        let bestDot = -2
        for (let f = 0; f < 6; ++f) {
          const fd = faceDirection(f, SIZE / 2, SIZE / 2)
          if (fd.dot(d) > bestDot) {
            bestDot = fd.dot(d)
            best = f
          }
        }
        void best
        s += sampleDir(d)
      }
      return s / 360
    }
    const sampleDir = (d: Vector3) => {
      // brute-force nearest texel on the dominant face
      const a = [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)]
      const face = a[0]! >= a[1]! && a[0]! >= a[2]! ? (d.x > 0 ? 0 : 1) : a[1]! >= a[2]! ? (d.y > 0 ? 2 : 3) : d.z > 0 ? 4 : 5
      let best = 0
      let bestDot = -2
      for (let y = 0; y < SIZE; y += 8) for (let x = 0; x < SIZE; x += 8) {
        const dd = faceDirection(face, x, y).dot(d)
        if (dd > bestDot) {
          bestDot = dd
          best = (y * SIZE + x) * 4
        }
      }
      return faces[face]![best]!
    }
    const itcz = zonal(5)
    const sub = (zonal(25) + zonal(-25)) / 2
    const storm = (zonal(52) + zonal(-52)) / 2
    console.info(`[weather] zonal low cloudiness ITCZ ${itcz.toFixed(3)} subtropics ${sub.toFixed(3)} storm ${storm.toFixed(3)}`)
    expect(itcz).toBeGreaterThan(sub)
    expect(storm).toBeGreaterThan(sub)
  })

  it('reports the cloudiness distribution (for coverage calibration)', () => {
    const vals: number[][] = [[], [], []]
    for (const f of faces) for (let i = 0; i < f.length; i += 4 * 7) for (let c = 0; c < 3; ++c) vals[c]!.push(f[i + c]!)
    const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))]!
    console.info(`[weather] percentiles p10/p50/p90 low ${[0.1, 0.5, 0.9].map((p) => q(vals[0]!, p).toFixed(2))} mid ${[0.1, 0.5, 0.9].map((p) => q(vals[1]!, p).toFixed(2))} cirrus ${[0.1, 0.5, 0.9].map((p) => q(vals[2]!, p).toFixed(2))}`)
    // A usable dynamic range: the field must not be nearly constant.
    expect(q(vals[0]!, 0.9) - q(vals[0]!, 0.1)).toBeGreaterThan(0.3)
  })
})

describe('3D noise textures', () => {
  it('shape and detail noise tile seamlessly (wrap jumps ≈ interior jumps)', () => {
    for (const [tex, n] of [[res.shape.texture, 128], [res.detail.texture, 32]] as const) {
      const first = readback.read3DLayer(renderer, tex, n, n, 0)
      const second = readback.read3DLayer(renderer, tex, n, n, 1)
      const last = readback.read3DLayer(renderer, tex, n, n, n - 1)
      let wrap = 0
      let inner = 0
      for (let i = 0; i < n * n; ++i) {
        wrap += Math.abs(first[i * 4]! - last[i * 4]!)
        inner += Math.abs(first[i * 4]! - second[i * 4]!)
      }
      expect(wrap / (n * n)).toBeLessThan(2 * (inner / (n * n)) + 1e-3)
      let mean = 0
      for (let i = 0; i < n * n; ++i) mean += first[i * 4]!
      mean /= n * n
      expect(mean).toBeGreaterThan(0.05)
      expect(mean).toBeLessThan(0.95)
    }
  })
})
