import { expect, test, type Page } from '@playwright/test'
import { openApp, renderFrames } from './helpers'

/**
 * L3-21: real pointer input through the browser. The geodetic point grabbed
 * under the cursor must stay under the cursor (±2 px), and the wheel must
 * change altitude monotonically.
 */

async function pick(page: Page, x: number, y: number) {
  return page.evaluate(([a, b]) => window.__earth!.pick(a!, b!), [x, y])
}

async function pixelDistanceToPoint(page: Page, target: { lon: number; lat: number }, x: number, y: number) {
  // Search the neighbourhood for the pixel whose pick is closest to the target.
  let best = { d: Infinity, x, y }
  for (let dy = -4; dy <= 4; ++dy) {
    for (let dx = -4; dx <= 4; ++dx) {
      const p = await pick(page, x + dx, y + dy)
      if (!p) continue
      const d = Math.hypot(p.lon - target.lon, p.lat - target.lat)
      if (d < best.d) best = { d, x: x + dx, y: y + dy }
    }
  }
  return Math.hypot(best.x - x, best.y - y)
}

test.describe('Google-Earth style interaction', () => {
  for (const alt of [5_000, 2_000_000]) {
    test(`grab-drag keeps the grabbed point under the cursor at ${alt} m`, async ({ page }) => {
      await openApp(page, { params: { lon: 127, lat: 37.5, alt, tod: 12 } })
      const start = { x: 250, y: 160 }
      const grabbed = (await pick(page, start.x, start.y))!
      expect(grabbed).not.toBeNull()
      await page.mouse.move(start.x + 0.5, start.y + 0.5)
      await page.mouse.down()
      for (let i = 1; i <= 10; ++i) await page.mouse.move(start.x + 0.5 + i * 8, start.y + 0.5 + i * 4)
      const end = { x: start.x + 80, y: start.y + 40 }
      await renderFrames(page, 1)
      expect(await pixelDistanceToPoint(page, grabbed, end.x, end.y)).toBeLessThanOrEqual(2)
      await page.mouse.up()
    })
  }

  test('wheel zoom changes altitude monotonically and UI state follows', async ({ page }) => {
    await openApp(page, { params: { lon: 0, lat: 0, alt: 10_000_000, tod: 12 } })
    await page.mouse.move(320, 180)
    let prev = (await page.evaluate(() => window.__earth!.getState())).camera.alt
    for (let i = 0; i < 6; ++i) {
      await page.mouse.wheel(0, -200)
      await renderFrames(page, 20) // smooth zoom settles over frames
      const alt = (await page.evaluate(() => window.__earth!.getState())).camera.alt
      expect(alt).toBeLessThan(prev)
      prev = alt
    }
    for (let i = 0; i < 3; ++i) {
      await page.mouse.wheel(0, 200)
      await renderFrames(page, 20)
      const alt = (await page.evaluate(() => window.__earth!.getState())).camera.alt
      expect(alt).toBeGreaterThan(prev)
      prev = alt
    }
  })

  test('right-drag orbits: tilt increases, heading changes', async ({ page }) => {
    await openApp(page, { params: { lon: 127, lat: 37.5, alt: 20_000, tod: 12 } })
    await page.mouse.move(320, 180)
    await page.mouse.down({ button: 'right' })
    for (let i = 1; i <= 10; ++i) await page.mouse.move(320 + i * 6, 180 - i * 8)
    await page.mouse.up({ button: 'right' })
    const s = (await page.evaluate(() => window.__earth!.getState())).camera
    expect(s.tilt).toBeGreaterThan(10)
    expect(Math.abs(s.heading - 0)).toBeGreaterThan(5)
  })
})
