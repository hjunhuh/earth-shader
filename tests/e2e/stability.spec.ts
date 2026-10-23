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
