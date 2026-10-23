import { afterAll, describe, expect, it } from 'vitest'
import { EffectComposer, EffectPass, RenderPass } from 'postprocessing'
import {
  DataTexture,
  FloatType,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import { SunEffect } from '../../src/scene/SunEffect'
import { glareFraction, glarePsf, LIMB_DARKENING, sunDiskSolidAngle } from '../../src/scene/sunModel'

const R = 0.004675 // takram's sun angular radius
const canvas = document.createElement('canvas')
const renderer = new WebGLRenderer({ canvas, depth: false })
renderer.setPixelRatio(1)
afterAll(() => {
  renderer.dispose()
  renderer.forceContextLoss()
})

interface Setup {
  width: number
  height: number
  fov: number
  glare?: number
  corona?: number
  occluder?: boolean
  overlayAlpha?: number
}

/** Render the sun alone (black sky, sun straight ahead) and read the float result. */
function render({ width, height, fov, glare = 0, corona = 0, occluder = false, overlayAlpha }: Setup) {
  renderer.setSize(width, height, false)
  const camera = new PerspectiveCamera(fov, width / height, 0.1, 1e4)
  camera.updateMatrixWorld()
  const scene = new Scene()
  if (occluder) {
    // Covers the lower half of the view: depth < 1 there.
    const plane = new Mesh(new PlaneGeometry(1000, 1000), new MeshBasicMaterial({ color: 0x000000 }))
    plane.position.set(0, -500, -100)
    scene.add(plane)
  }
  const composer = new EffectComposer(renderer, { frameBufferType: FloatType, multisampling: 0 })
  composer.autoRenderToScreen = false
  composer.addPass(new RenderPass(scene, camera))
  const sun = new SunEffect(camera, { glare, corona })
  sun.illuminanceOverride = new Vector3(1, 1, 1)
  sun.sunDirection.set(0, 0, -1)
  if (overlayAlpha !== undefined) {
    const data = new Float32Array(width * height * 4)
    for (let i = 0; i < width * height; ++i) data[i * 4 + 3] = overlayAlpha
    const overlay = new DataTexture(data, width, height, RGBAFormat, FloatType)
    overlay.needsUpdate = true
    sun.overlayMap = overlay
  }
  composer.addPass(new EffectPass(camera, sun))
  composer.setSize(width, height)
  composer.render(1 / 60)
  composer.render(1 / 60) // second frame: overlay defines compiled, visibility measured
  const read = (target: { width: number; height: number } & object) => {
    const out = new Float32Array(width * height * 4)
    renderer.readRenderTargetPixels(target as never, 0, 0, width, height, out)
    return out
  }
  const a = read(composer.inputBuffer)
  const b = read(composer.outputBuffer)
  const center = ((height >> 1) * width + (width >> 1)) * 4
  const image = a[center]! > b[center]! ? a : b
  const vis = new Float32Array(4)
  renderer.readRenderTargetPixels((sun as unknown as { visibilityTarget: never }).visibilityTarget, 0, 0, 1, 1, vis)
  const focal = height / 2 / Math.tan((fov * Math.PI) / 360)
  composer.dispose()
  return { image, focal, visibility: vis[0]!, coverage: vis[1]!, width, height }
}

/** Angle from the view axis and solid angle of pixel (x, y), bottom-left origin. */
function pixel(r: ReturnType<typeof render>, x: number, y: number) {
  const dx = (x + 0.5 - r.width / 2) / r.focal
  const dy = (y + 0.5 - r.height / 2) / r.focal
  const len2 = 1 + dx * dx + dy * dy
  return { theta: Math.atan(Math.sqrt(dx * dx + dy * dy)), omega: 1 / (r.focal * r.focal * len2 ** 1.5) }
}

/** Σ radiance × solid angle within `radius` (radians) of the sun, per channel. */
function energy(r: ReturnType<typeof render>, radius: number): number[] {
  const sum = [0, 0, 0]
  for (let y = 0; y < r.height; ++y) {
    for (let x = 0; x < r.width; ++x) {
      const p = pixel(r, x, y)
      if (p.theta > radius) continue
      const i = (y * r.width + x) * 4
      for (let c = 0; c < 3; ++c) sum[c]! += r.image[i + c]! * p.omega
    }
  }
  return sum
}

describe('sun disk', () => {
  for (const [name, setup] of [
    ['sub-pixel disk (96 px tall, 75°)', { width: 160, height: 96, fov: 75 }],
    ['app scale (360 px tall, 75°)', { width: 640, height: 360, fov: 75 }],
    ['resolved disk (256 px tall, 3°)', { width: 256, height: 256, fov: 3 }],
  ] as const) {
    it(`conserves the sun's energy: ${name}`, () => {
      const r = render(setup)
      const e = energy(r, 6 * R)
      for (const v of e) expect(Math.abs(v - 1) / 1).toBeLessThan(0.03)
    })
  }

  it('limb darkening follows 1 − u(1 − μ) per channel, and the edge is anti-aliased', () => {
    const r = render({ width: 256, height: 256, fov: 2 })
    const cx = 128
    const cy = 128
    const at = (x: number, y: number) => r.image.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 3)
    const center = Array.from(at(cx, cy))
    let edgeSamples = 0
    for (let x = cx; x < 256; ++x) {
      const p = pixel(r, x, cy)
      const t = p.theta / R
      const v = at(x, cy)
      if (t < 0.9) {
        const mu = Math.sqrt(1 - t * t)
        for (let c = 0; c < 3; ++c) expect(v[c]! / center[c]!).toBeCloseTo(1 - LIMB_DARKENING[c]! * (1 - mu), 1)
      } else if (v[1]! > 0 && v[1]! < 0.9 * center[1]! * (1 - LIMB_DARKENING[1]!) ) {
        edgeSamples++
      }
    }
    expect(edgeSamples).toBeGreaterThan(0) // partially covered edge pixels exist
    // Limb is redder than the center.
    const limb = at(Math.round(cx + 0.85 * R * r.focal), cy)
    expect(limb[0]! / limb[2]!).toBeGreaterThan(center[0]! / center[2]!)
  })

  it('is hidden by geometry (depth < 1): only the sky half of the disk is drawn', () => {
    const r = render({ width: 256, height: 256, fov: 3, occluder: true })
    const full = render({ width: 256, height: 256, fov: 3 })
    let lower = 0
    let upper = 0
    for (let y = 0; y < 256; ++y) {
      for (let x = 0; x < 256; ++x) {
        const v = r.image[(y * 256 + x) * 4 + 1]!
        if (y < 126) lower += v
        else if (y > 130) upper += v
      }
    }
    expect(lower).toBe(0)
    expect(upper).toBeGreaterThan(0)
    expect(r.visibility).toBeGreaterThan(0.4)
    expect(r.visibility).toBeLessThan(0.6)
    expect(full.visibility).toBeCloseTo(1, 3)
  })

  it('is attenuated by clouds in front (overlay alpha)', () => {
    const opaque = render({ width: 256, height: 256, fov: 3, overlayAlpha: 1 })
    const half = render({ width: 256, height: 256, fov: 3, overlayAlpha: 0.5 })
    expect(Math.max(...energy(opaque, 6 * R))).toBeLessThan(1e-6)
    expect(opaque.visibility).toBeLessThan(1e-3)
    for (const v of energy(half, 6 * R)) expect(v).toBeCloseTo(0.5, 2)
    expect(half.visibility).toBeCloseTo(0.5, 2)
  })
})

describe('sun glare', () => {
  it('follows the Spencer PSF tail: E·glare·PSF(θ)', () => {
    const glare = 0.8
    const r = render({ width: 512, height: 512, fov: 60, glare })
    for (const deg of [1.5, 3, 6, 12, 24]) {
      const theta = (deg * Math.PI) / 180
      const x = Math.round(256 + Math.tan(theta) * r.focal - 0.5)
      const p = pixel(r, x, 256)
      const effective = Math.sqrt(p.theta ** 2 + R ** 2)
      const want = glare * glarePsf((effective * 180) / Math.PI)
      const got = r.image[(256 * 512 + x) * 4 + 1]!
      expect(Math.abs(got - want) / want).toBeLessThan(0.02)
    }
  })

  it('takes its energy from the disk (energy split 1 − glare·0.616 : glare·0.616)', () => {
    const r = render({ width: 256, height: 256, fov: 3, glare: 0.5 })
    const none = render({ width: 256, height: 256, fov: 3, glare: 0 })
    const disk = energy(r, R * 1.0)[1]! - 0 // glare inside the disk is small but present
    const diskOnly = energy(none, 6 * R)[1]!
    expect(diskOnly).toBeCloseTo(1, 1)
    expect(disk).toBeLessThan(diskOnly * (1 - glareFraction(0.5)) * 1.2)
    expect(sunDiskSolidAngle(R)).toBeCloseTo(Math.PI * R * R, 9)
  })

  it('the ciliary corona redistributes glare around the circle without changing its ring average', () => {
    const smooth = render({ width: 512, height: 512, fov: 40, glare: 1, corona: 0 })
    const streaked = render({ width: 512, height: 512, fov: 40, glare: 1, corona: 0.5 })
    const ring = (img: Float32Array) => {
      // Bilinear samples on a 1.5° ring, where the ocular-scattering term (which carries the corona) is large.
      const sample = (x: number, y: number) => {
        const x0 = Math.floor(x - 0.5)
        const y0 = Math.floor(y - 0.5)
        const fx = x - 0.5 - x0
        const fy = y - 0.5 - y0
        const v = (i: number, j: number) => img[((y0 + j) * 512 + (x0 + i)) * 4 + 1]!
        return (v(0, 0) * (1 - fx) + v(1, 0) * fx) * (1 - fy) + (v(0, 1) * (1 - fx) + v(1, 1) * fx) * fy
      }
      const values: number[] = []
      const radius = Math.tan((1.5 * Math.PI) / 180) * smooth.focal
      for (let k = 0; k < 1440; ++k) {
        const a = (k / 1440) * 2 * Math.PI
        values.push(sample(256 + radius * Math.cos(a), 256 + radius * Math.sin(a)))
      }
      const mean = values.reduce((s, v) => s + v, 0) / values.length
      const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
      return { mean, sd }
    }
    const a = ring(smooth.image)
    const b = ring(streaked.image)
    expect(Math.abs(b.mean - a.mean) / a.mean).toBeLessThan(0.03)
    expect(a.sd / a.mean).toBeLessThan(0.01) // smooth glare is round
    expect(b.sd / b.mean).toBeGreaterThan(0.04) // streaks are visible

  })
})
