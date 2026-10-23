import { expect, test, type Page } from '@playwright/test'
import { solarPosition } from '../../src/time/solar'
import { timeOfDayAt } from '../../src/time/timeOfDay'
import { openApp, renderFrames } from './helpers'

const Y = (c: number[], i = 0) => 0.2126 * c[i]! + 0.7152 * c[i + 1]! + 0.0722 * c[i + 2]!

function todFor(lat: number, lon: number, elevation: number, morning: boolean): number {
  const day = Date.UTC(2026, 2, 20)
  let best = { t: day, err: Infinity }
  for (let m = 0; m < 2880; m += 0.25) {
    const t = day - 12 * 3_600_000 + m * 60_000
    const p = solarPosition(t, lat, lon)
    if (p.hourAngle < 0 !== morning) continue
    const err = Math.abs(90 - p.zenith - elevation)
    if (err < best.err) best = { t, err }
  }
  return timeOfDayAt(best.t, lon)
}

/** Reads the resolved cloud buffer and returns per-pixel {x, y, L, a}. */
async function cloudPixels(page: Page) {
  return page.evaluate(() => {
    const e = window.__earth!
    const { width, height } = e.cloudSize()
    const c = e.readClouds(0, 0, width, height)
    return { width, height, c }
  })
}

test.describe('clouds: lighting structure and temporal stability', () => {
  test('self-shadowing: the sun-facing side of a cloud is ≥ 2× brighter than the far side', async ({ page }) => {
    // Camera 8 km south of a blob, at blob height, looking north; sun low in the east.
    await openApp(page, {
      params: { lon: 0, lat: -0.072, alt: 1750, tilt: 88, heading: 0, tod: todFor(0, 0, 20, true), weather: 'blob:0,0,1000,2500,1500', physical: 1 },
    })
    const { width, height, c } = await cloudPixels(page)
    let minX = width
    let maxX = 0
    for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) if (c[(y * width + x) * 4 + 3]! > 0.95) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
    }
    const third = (maxX - minX) / 3
    let east = 0
    let west = 0
    let ne = 0
    let nw = 0
    for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
      const i = (y * width + x) * 4
      if (c[i + 3]! <= 0.95) continue
      if (x > maxX - third) { east += Y(c, i); ne++ }
      if (x < minX + third) { west += Y(c, i); nw++ }
    }
    expect(ne).toBeGreaterThan(20)
    expect(east / ne, `east ${(east / ne).toFixed(3)} west ${(west / nw).toFixed(3)}`).toBeGreaterThan(2 * (west / nw))
  })

  test('silver lining: backlit thin cloud edges outshine the opaque core', async ({ page }) => {
    // Camera west of the blob looking east toward a low sun behind it.
    await openApp(page, {
      params: { lon: -0.072, lat: 0, alt: 1750, tilt: 88, heading: 90, tod: todFor(0, 0, 4, true), weather: 'blob:0,0,1000,2500,1500', physical: 1 },
    })
    const { width, height, c } = await cloudPixels(page)
    let edge = 0
    let ne = 0
    let core = 0
    let nc = 0
    for (let i = 0; i < width * height * 4; i += 4) {
      const a = c[i + 3]!
      // Premultiplied luminance per unit opacity.
      if (a > 0.05 && a < 0.5) { edge += Y(c, i) / a; ne++ }
      if (a > 0.99) { core += Y(c, i); nc++ }
    }
    expect(ne).toBeGreaterThan(10)
    expect(nc).toBeGreaterThan(10)
    expect(edge / ne, `edge ${(edge / ne).toFixed(3)} core ${(core / nc).toFixed(3)}`).toBeGreaterThan(core / nc)
  })

  test('LOD continuity: an altitude sweep 9 km → 3,000 km over a cloud field has no radiance pops', async ({ page }) => {
    await openApp(page, { params: { lon: -30, lat: 5, alt: 9000, tilt: 0, tod: 12 }, frames: 32 })
    const steps = 30
    const means: number[] = []
    for (let i = 0; i <= steps; ++i) {
      const alt = 9000 * (3_000_000 / 9000) ** (i / steps)
      await page.evaluate((a) => window.__earth!.setCamera({ alt: a }), alt)
      await renderFrames(page, 24)
      const s = await page.evaluate(() => window.__earth!.hdrStats(280, 140, 80, 80))
      expect(s.nonFinite).toBe(0)
      means.push(0.2126 * s.mean[0] + 0.7152 * s.mean[1] + 0.0722 * s.mean[2])
    }
    for (let i = 1; i < means.length; ++i) {
      const change = Math.abs(means[i]! - means[i - 1]!) / Math.max(means[i - 1]!, 1e-9)
      expect(change, `pop between steps ${i - 1} and ${i}`).toBeLessThan(0.15)
    }
  })

  test('temporal stability: a converged static view changes < 0.5% frame to frame', async ({ page }) => {
    await openApp(page, { params: { lon: -30, lat: 5, alt: 30_000, tilt: 50, heading: 270, tod: 15 }, frames: 64 })
    const diffs = await page.evaluate(() => {
      const e = window.__earth!
      const { width, height } = e.size()
      const out: number[] = []
      let prev = e.readHdr(0, 0, width, height)
      for (let f = 0; f < 8; ++f) {
        e.renderFrames(1)
        const cur = e.readHdr(0, 0, width, height)
        let d = 0
        let m = 0
        for (let i = 0; i < cur.length; i += 4) {
          d += Math.abs(cur[i + 1]! - prev[i + 1]!)
          m += cur[i + 1]!
        }
        out.push(d / m)
        prev = cur
      }
      return out
    })
    for (const d of diffs) expect(d).toBeLessThan(0.005)
  })

  test('ghosting decays: 16 frames after a camera move the image is as clean as a cold start', async ({ page }) => {
    // Ghosting (stale history) must be gone once every pixel got a fresh
    // sample (k² = 16 frames); remaining error is then sampling noise, so the
    // comparison is against a cold start at the target after 16 frames.
    const target = { lon: -30.05, lat: 5, alt: 30_000, tilt: 50, heading: 270, tod: 15 }
    const readAll = () =>
      page.evaluate(() => {
        const { width, height } = window.__earth!.size()
        return window.__earth!.readHdr(0, 0, width, height)
      })
    const error = (a: number[], ref: number[]) => {
      let d = 0
      let m = 0
      for (let i = 0; i < a.length; i += 4) {
        d += Math.abs(a[i + 1]! - ref[i + 1]!)
        m += ref[i + 1]!
      }
      return d / m
    }
    await openApp(page, { params: target, frames: 96 })
    const ref = await readAll()
    await openApp(page, { params: target, frames: 16 })
    const cold = error(await readAll(), ref)
    await openApp(page, { params: { ...target, lon: -30 }, frames: 64 })
    await page.evaluate((lon) => window.__earth!.setCamera({ lon }), target.lon)
    await page.evaluate(() => window.__earth!.renderFrames(1))
    const afterMove = error(await readAll(), ref)
    await page.evaluate(() => window.__earth!.renderFrames(15))
    const after16 = error(await readAll(), ref)
    expect(afterMove, 'the move must actually perturb the image').toBeGreaterThan(cold)
    expect(after16, `after move ${afterMove.toFixed(4)}, after 16 ${after16.toFixed(4)}, cold start ${cold.toFixed(4)}`).toBeLessThan(cold * 1.3 + 0.002)
  })
})
