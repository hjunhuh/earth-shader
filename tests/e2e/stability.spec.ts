import { expect, test } from '@playwright/test'
import { APP, camera, luma, open, readPixels, REF, renderFrames, type CameraState } from './helpers'
import type { Page } from '@playwright/test'

test.describe('stability', () => {
  test('zooming out to orbit keeps the ocean in the depth range and renders without errors', async ({ page }) => {
    await open(page, APP, { tod: 12 }, { frames: 0 })
    const c = await zoomToOrbit(page)
    const r = Math.hypot(...c.position)
    expect(r - 6378137).toBeGreaterThan(1e6)
    expect(c.far).toBeGreaterThan(4e5)
    const px = await readPixels(page)
    // Planet center is lit blue ocean, the corner is black space.
    const center = (180 * 640 + 320) * 4
    expect(px[center + 2]!).toBeGreaterThan(px[center]! + 10)
    expect(luma(px, center)).toBeGreaterThan(20)
    expect(luma(px, 0)).toBeLessThan(10)
    expect(await page.evaluate(() => window.__earth!.errors)).toEqual([])
  })

  test('space is black from orbit (takram 0.19.1 unpatched renders it blue: negative control)', async ({ page, browser }) => {
    await open(page, APP, { tod: 12 }, { frames: 0 })
    await zoomToOrbit(page)
    const ref = await browser.newPage()
    await open(ref, REF, { tod: 12 }, { frames: 0 })
    await zoomToOrbit(ref)
    const corners = async (p: Page) => {
      const px = await readPixels(p)
      return [0, 639, 359 * 640, 359 * 640 + 639].map((i) => luma(px, i * 4))
    }
    for (const v of await corners(page)) expect(v).toBeLessThan(8) // dithering noise only
    expect(Math.max(...(await corners(ref)))).toBeGreaterThan(40)
    await ref.close()
  })

  test('space is black from just below the top of the atmosphere (takram 0.19.1 LUT renders it blue: negative control)', async ({ page, browser }) => {
    // Orbit target at 30 km, camera pulled back at a 30° pitch: the sweep puts
    // the camera through the last ~4 km under the atmosphere top (about
    // 56–60 km with correctAltitude), where the bad LUT texel shows up.
    const sweep = async (p: Page, path: string) => {
      await open(p, path, { tod: 8, alt: 30_000 }, { frames: 0 })
      const tops: { altitude: number; luma: number }[] = []
      for (let d = 46_000; d <= 62_000; d += 1_000) {
        await p.evaluate((d) => window.__earth!.setPointOfView(0, -30, d), d)
        await renderFrames(p, 10)
        const c = await camera(p)
        const px = await readPixels(p, 0, 0, 640, 20)
        let s = 0
        for (let i = 0; i < px.length; i += 4) s += luma(px, i)
        tops.push({ altitude: Math.round(Math.hypot(...c.position) - 6371e3), luma: s / (px.length / 4) })
      }
      return tops
    }
    const app = await sweep(page, APP)
    const ref = await browser.newPage()
    const reference = await sweep(ref, REF)
    await ref.close()
    for (const t of app) expect(t.luma, `app at r − 6371 km = ${t.altitude} m`).toBeLessThan(8)
    expect(Math.max(...reference.map((t) => t.luma))).toBeGreaterThan(40)
  })

  test('zoomed out over the ocean: no cloud-shadow patch or disc (takram 0.19.1 shows them: negative control)', async ({ page, browser }) => {
    // Noon: the last shadow cascade's box leaves a hard-edged patch of
    // blotches. Morning: the light-shaft term darkens a disc around nadir.
    const views = [
      { tod: 12, distance: 200_000 },
      { tod: 8, distance: 150_000 },
    ]
    const ref = await browser.newPage()
    for (const { tod, distance } of views) {
      const scores: number[] = []
      for (const [p, path] of [[page, APP], [ref, REF]] as const) {
        await open(p, path, { tod }, { frames: 0 })
        await p.evaluate((d) => window.__earth!.setPointOfView(0, -89, d), distance)
        await renderFrames(p, 60)
        scores.push(lowFrequencyBumps(await readPixels(p), 640, 360))
      }
      const [app, reference] = scores as [number, number]
      console.info(`[bumps] tod ${tod}: app ${app.toFixed(2)}, takram ${reference.toFixed(2)}`)
      expect(app, `app, tod ${tod}`).toBeLessThan(4) // smooth lighting gradients only (≈2.5–2.7)
      expect(reference, `takram, tod ${tod}`).toBeGreaterThan(5) // ≈7
    }
    await ref.close()
  })

  test('a full day renders: bright at noon, dark at midnight, no errors', async ({ page }) => {
    const mean: number[] = []
    for (const tod of [0, 4, 8, 12, 16, 20]) {
      await open(page, APP, { tod }, { frames: 30 })
      const px = await readPixels(page)
      let s = 0
      for (let i = 0; i < px.length; i += 4) s += luma(px, i)
      mean.push(s / (px.length / 4))
    }
    expect(mean[3]!).toBeGreaterThan(mean[0]! + 50)
    expect(mean[0]!).toBeLessThan(15)
  })
})

/**
 * Largest second difference between neighboring 40 px cells of the median
 * luma. Medians ignore small bright clouds; second differences ignore smooth
 * lighting gradients. Edges and blobs larger than a cell score high.
 */
function lowFrequencyBumps(px: number[], width: number, height: number, size = 40): number {
  const nx = Math.floor(width / size)
  const ny = Math.floor(height / size)
  const m: number[][] = []
  for (let j = 0; j < ny; ++j) {
    m.push([])
    for (let i = 0; i < nx; ++i) {
      const v: number[] = []
      for (let y = j * size; y < (j + 1) * size; ++y) {
        for (let x = i * size; x < (i + 1) * size; ++x) v.push(luma(px, (y * width + x) * 4))
      }
      v.sort((a, b) => a - b)
      m[j]!.push(v[v.length >> 1]!)
    }
  }
  let max = 0
  for (let j = 0; j < ny; ++j) {
    for (let i = 0; i < nx; ++i) {
      if (i > 0 && i + 1 < nx) max = Math.max(max, Math.abs(m[j]![i - 1]! - 2 * m[j]![i]! + m[j]![i + 1]!))
      if (j > 0 && j + 1 < ny) max = Math.max(max, Math.abs(m[j - 1]![i]! - 2 * m[j]![i]! + m[j + 1]![i]!))
    }
  }
  return max
}

/** Look straight down, then dolly out ~3,700 km with the wheel. */
async function zoomToOrbit(page: Page): Promise<CameraState> {
  await page.evaluate(() => window.__earth!.setPointOfView(0, -89, 1000))
  await page.mouse.move(320, 180)
  for (let i = 0; i < 160; ++i) {
    await page.mouse.wheel(0, 100)
    await renderFrames(page, 1)
  }
  await renderFrames(page, 60)
  return camera(page)
}
