import { expect, test, type Page } from '@playwright/test'
import { Body, Equator, Horizon, Observer } from 'astronomy-engine'
import { APP, luma, open, readPixels, renderFrames } from './helpers'

/** Sun altitude/azimuth in degrees from the app's ECEF sun direction, in the local ENU frame. */
function altAz(sun: number[], lon: number, lat: number): { alt: number; az: number } {
  const l = (lon * Math.PI) / 180
  const p = (lat * Math.PI) / 180
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)]
  const east = [-Math.sin(l), Math.cos(l), 0]
  const north = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)]
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  return {
    alt: (Math.asin(dot(sun, up)) * 180) / Math.PI,
    az: ((((Math.atan2(dot(sun, east), dot(sun, north)) * 180) / Math.PI) % 360) + 360) % 360,
  }
}

async function sunPixel(page: Page) {
  return page.evaluate(() => window.__earth!.projectSun())
}

test.describe('the sun', () => {
  test('is where astronomy-engine puts it for the panel’s date and location', async ({ page }) => {
    for (const [lon, lat, doy, tod] of [
      [30, 35, 1, 8],
      [30, 35, 1, 12],
      [127, 37.5, 170, 17.5],
      [-0.13, 51.5, 80, 9.4],
    ] as const) {
      await open(page, APP, { lon, lat, doy, tod }, { frames: 1 })
      const { sun, date } = await page.evaluate(() => ({ sun: window.__earth!.sunDirection(), date: window.__earth!.dateMs() }))
      const eq = Equator(Body.Sun, new Date(date), new Observer(lat, lon, 0), true, true)
      const hor = Horizon(new Date(date), new Observer(lat, lon, 0), eq.ra, eq.dec)
      const got = altAz(sun, lon, lat)
      // Geodetic vs geocentric latitude of the ENU frame used here: ≤ 0.2°.
      expect(Math.abs(got.alt - hor.altitude)).toBeLessThan(0.25)
      expect(Math.abs(((got.az - hor.azimuth + 540) % 360) - 180)).toBeLessThan(0.5)
    }
  })

  test('is visible at start: on screen, saturated, and the brightest spot with a glare halo', async ({ page }) => {
    await open(page, APP)
    const s = await sunPixel(page)
    expect(s.inFront).toBe(true)
    expect(s.x).toBeGreaterThan(0)
    expect(s.x).toBeLessThan(640)
    expect(s.y).toBeGreaterThan(0)
    expect(s.y).toBeLessThan(360)
    const all = await readPixels(page)
    const at = (x: number, y: number) => ((Math.round(y) * 640 + Math.round(x)) * 4)
    const core = all.slice(at(s.x, s.y), at(s.x, s.y) + 3)
    for (const c of core) expect(c).toBeGreaterThanOrEqual(245)
    // Halo: 20 px away still clearly brighter than sky 200 px away.
    const near = luma(all, at(s.x + 20, s.y))
    const far = luma(all, at(Math.min(639, s.x + 200), s.y))
    expect(near).toBeGreaterThan(far + 15)
  })

  test('below the horizon at night: no saturated sky', async ({ page }) => {
    await open(page, APP, { tod: 23, clouds: 0 })
    const all = await readPixels(page)
    let saturated = 0
    for (let i = 0; i < all.length; i += 4) if (all[i]! > 245 && all[i + 1]! > 245 && all[i + 2]! > 245) saturated++
    expect(saturated).toBe(0)
  })

  test('timeOfDay moves it: rises through the morning, sets in the evening', async ({ page }) => {
    const alts: number[] = []
    for (const tod of [6, 8, 10, 12, 14, 16, 18]) {
      await open(page, APP, { tod, clouds: 0 }, { frames: 1 })
      alts.push(altAz(await page.evaluate(() => window.__earth!.sunDirection()), 30, 35).alt)
    }
    expect(alts[0]).toBeLessThan(0) // 06:00 on Jan 2 at 35°N: before sunrise
    expect(alts[1]).toBeGreaterThan(0)
    for (let i = 1; i <= 3; ++i) expect(alts[i]!).toBeGreaterThan(alts[i - 1]!)
    for (let i = 4; i < alts.length; ++i) expect(alts[i]!).toBeLessThan(alts[i - 1]!)
    expect(alts[6]).toBeLessThan(0)
  })

  test('editing timeOfDay moves the sun (springs jump in test mode)', async ({ page }) => {
    // In test mode springs jump, so a single frame after the edit shows the final sun.
    await open(page, APP, { tod: 8 }, { frames: 1 })
    const before = await page.evaluate(() => window.__earth!.sunDirection())
    await page.evaluate(() => window.__earth!.setState!({ date: { timeOfDay: 9 } }))
    await renderFrames(page, 1)
    const after = await page.evaluate(() => window.__earth!.sunDirection())
    expect(altAz(after, 30, 35).alt).toBeGreaterThan(altAz(before, 30, 35).alt + 5)
  })
})
