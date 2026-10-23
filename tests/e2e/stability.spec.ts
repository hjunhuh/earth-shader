import { expect, test } from '@playwright/test'
import { hdrStats, luminance, openApp, renderFrames } from './helpers'

/**
 * L3-17 / L3-18: sweeps that must never produce NaN/Inf and must not pop.
 * Sun is kept high (tod 12 at the camera longitude) so luminance is defined.
 */
test.describe('stability sweeps', () => {
  test('altitude sweep 50 m → 40,000 km: no NaN/Inf, no luminance pops', async ({ page }) => {
    const { width, height } = await openApp(page, { params: { lon: 0, lat: 10, tod: 12, tilt: 0, clouds: 0 } })
    const steps = 40
    const lums: number[] = []
    for (let i = 0; i <= steps; ++i) {
      const alt = 50 * (40_000_000 / 50) ** (i / steps)
      await page.evaluate((a) => window.__earth!.setCamera({ alt: a }), alt)
      await renderFrames(page, 2)
      const full = await hdrStats(page, 0, 0, width, height)
      expect(full.nonFinite, `non-finite at ${alt.toFixed(0)} m`).toBe(0)
      // Mean over a central patch (always ocean in a nadir view).
      const center = await hdrStats(page, width / 2 - 4, height / 2 - 4, 8, 8)
      lums.push(luminance(center.mean))
    }
    for (let i = 1; i < lums.length; ++i) {
      const change = Math.abs(lums[i]! - lums[i - 1]!) / Math.max(lums[i - 1]!, 1e-9)
      expect(change, `pop between steps ${i - 1} and ${i}`).toBeLessThan(0.15)
    }
  })

  test('time-of-day sweep 0 → 24 h: no NaN/Inf', async ({ page }) => {
    const { width, height } = await openApp(page, { params: { lon: 30, lat: 20, alt: 2_000_000 } })
    for (let tod = 0; tod <= 24; tod += 0.25) {
      await page.evaluate((t) => window.__earth!.setTimeOfDay(t), tod)
      await renderFrames(page, 1)
      expect((await hdrStats(page, 0, 0, width, height)).nonFinite, `tod ${tod}`).toBe(0)
    }
  })

  test('distance buffer marks sky as -1 and ocean as positive meters', async ({ page }) => {
    const { width, height } = await openApp(page, { params: { lon: 0, lat: 0, alt: 15_000_000, tod: 12 } })
    const d = await page.evaluate(([w, h]) => window.__earth!.readDistance(0, 0, w!, h!), [width, height])
    const center = d[Math.floor(height / 2) * width + Math.floor(width / 2)]!
    expect(center).toBeGreaterThan(14_900_000)
    expect(center).toBeLessThan(15_100_000)
    expect(d[0]).toBe(-1)
  })
})
