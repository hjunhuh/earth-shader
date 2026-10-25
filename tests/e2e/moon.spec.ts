import { expect, test, type Page } from '@playwright/test'
import { Body, Equator, Horizon, Observer, SearchLocalSolarEclipse, SearchLunarEclipse } from 'astronomy-engine'
import { APP, luma, open, readPixels, renderFrames } from './helpers'

const W = 640
const H = 360
const DAY = 86400e3

/** Altitude/azimuth (degrees) of an ECEF direction in the geodetic ENU frame. */
function altAz(v: number[], lon: number, lat: number): { alt: number; az: number } {
  const l = (lon * Math.PI) / 180
  const p = (lat * Math.PI) / 180
  const n = Math.hypot(v[0]!, v[1]!, v[2]!)
  const d = v.map((x) => x / n)
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)]
  const east = [-Math.sin(l), Math.cos(l), 0]
  const north = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)]
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  return {
    alt: (Math.asin(dot(d, up)) * 180) / Math.PI,
    az: ((((Math.atan2(dot(d, east), dot(d, north)) * 180) / Math.PI) % 360) + 360) % 360,
  }
}

/** `doy`/`tod` URL values for a UTC instant at a longitude (localDate.ts, year 2026). */
function localTime(ms: number, lon: number): { doy: number; tod: number } {
  const days = (ms - Date.UTC(2026, 0, 1)) / DAY + lon / 360
  const doy = Math.floor(days)
  return { doy, tod: (days - doy) * 24 }
}

/** Pixels of the frame, with a predicate count and mean luma over matches. */
async function stats(page: Page, match: (p: number[], i: number) => boolean) {
  const all = await readPixels(page)
  let count = 0
  let sum = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < all.length; i += 4) {
    if (!match(all, i)) continue
    count++
    sum += luma(all, i)
    sx += (i / 4) % W
    sy += Math.floor(i / 4 / W)
  }
  return { count, mean: count ? sum / count : 0, cx: sx / count + 0.5, cy: sy / count + 0.5, all }
}

test.describe('the Moon', () => {
  test('is at its true topocentric position: parallax included', async ({ page }) => {
    for (const [lon, lat, doy, tod] of [
      [30, 35, 1, 22],
      [127, 37.5, 60, 23],
      [-70, -33, 120, 2],
    ] as const) {
      await open(page, APP, { lon, lat, doy, tod, clouds: 0 }, { frames: 1 })
      const { moon, target, date } = await page.evaluate(() => ({
        moon: window.__earth!.moonPosition!(),
        target: window.__earth!.camera().target,
        date: window.__earth!.dateMs(),
      }))
      const observer = new Observer(lat, lon, 300)
      const eq = Equator(Body.Moon, new Date(date), observer, true, true)
      const hor = Horizon(new Date(date), observer, eq.ra, eq.dec)
      const got = altAz([moon[0]! - target[0]!, moon[1]! - target[1]!, moon[2]! - target[2]!], lon, lat)
      expect(Math.abs(got.alt - hor.altitude)).toBeLessThan(0.03)
      expect(Math.abs(((got.az - hor.azimuth + 540) % 360) - 180) * Math.cos((hor.altitude * Math.PI) / 180)).toBeLessThan(0.03)
      // Seen from the Earth's center it would be higher by the parallax (~0.95°·cos alt).
      const geocentric = altAz(moon, lon, lat)
      expect(geocentric.alt - hor.altitude).toBeGreaterThan(0.8 * Math.cos((hor.altitude * Math.PI) / 180))
    }
  })

  test('has its true size: apparent radius matches the geometry', async ({ page }) => {
    // Near full moon (2026-01-03), from 20,000 km above the sub-Earth point.
    await open(page, APP, { focus: 'moon', moonLon: 0, moonLat: 0, moonAlt: 2e7, doy: 2, tod: 12 }, { frames: 2 })
    const p = await page.evaluate(() => window.__earth!.projectMoon!())
    expect(p.inFront).toBe(true)
    const focal = H / 2 / Math.tan((75 * Math.PI) / 360)
    expect(p.radius).toBeCloseTo(focal * Math.tan(Math.asin(1737400 / (1737400 + 2e7))), 6)
    const s = await stats(page, (a, i) => luma(a, i) > 12)
    expect(Math.abs(Math.sqrt(s.count / Math.PI) - p.radius)).toBeLessThan(1.5)
    expect(Math.abs(s.cx - p.x)).toBeLessThan(1.5)
    expect(Math.abs(s.cy - p.y)).toBeLessThan(1.5)
  })

  test('phase: the hemisphere toward the Sun is lit', async ({ page }) => {
    for (const doy of [25, 40]) {
      // First quarter (Jan 26) and waning gibbous (Feb 10).
      await open(page, APP, { focus: 'moon', moonLon: 0, moonLat: 0, moonAlt: 1e7, doy, tod: 12 }, { frames: 2 })
      const { center, toward } = await page.evaluate(() => {
        const app = (window as unknown as { __earthApp: { scene: any } }).__earthApp
        const s = app.scene
        const c = window.__earth!.projectMoon!()
        const p = s.moon.position.clone().sub(s.camera.position).addScaledVector(s.sunDirection, s.moon.radius)
        const ndc = p.add(s.camera.position).project(s.camera)
        return { center: c, toward: { x: (ndc.x * 0.5 + 0.5) * 640, y: (0.5 - ndc.y * 0.5) * 360 } }
      })
      const d = [toward.x - center.x, toward.y - center.y]
      const n = Math.hypot(d[0]!, d[1]!)
      const all = await readPixels(page)
      const at = (k: number) => {
        const x = Math.round(center.x + (d[0]! / n) * k * center.radius)
        const y = Math.round(center.y + (d[1]! / n) * k * center.radius)
        return luma(all, (y * W + x) * 4)
      }
      expect(at(0.6)).toBeGreaterThan(40)
      expect(at(-0.6)).toBeLessThan(at(0.6) / 4)
    }
  })

  test('close to the surface: lit terrain, deterministic, no precision jitter', async ({ page }) => {
    await open(page, APP, { focus: 'moon', moonAlt: 10000, moonTilt: 60, doy: 8, tod: 12 }, { frames: 2 })
    expect(await page.evaluate(() => window.__earth!.focus!())).toBe('moon')
    const a = await readPixels(page, 0, H / 2, W, H / 2)
    let sum = 0
    let black = 0
    for (let i = 0; i < a.length; i += 4) {
      sum += luma(a, i)
      if (a[i] === 0 && a[i + 1] === 0 && a[i + 2] === 0) black++
    }
    expect(sum / (a.length / 4)).toBeGreaterThan(30)
    expect(black).toBe(0)
    await renderFrames(page, 1)
    expect(await readPixels(page, 0, H / 2, W, H / 2)).toEqual(a)
    // Move 1 m: the image barely changes (no float32 jumps at 384,000 km from the origin).
    await page.evaluate(() => {
      const s = (window as unknown as { __earthApp: { scene: any } }).__earthApp.scene
      s.moonControls.zoom(1 + 1 / 10000)
      window.__earth!.renderFrames(1)
    })
    const b = await readPixels(page, 0, H / 2, W, H / 2)
    let diff = 0
    for (let i = 0; i < a.length; i += 4) diff += Math.abs(a[i]! - b[i]!)
    expect(diff / (a.length / 4)).toBeLessThan(1)
  })

  test('hides the Earth behind it, and the Earth shows around it from farther away', async ({ page }) => {
    // New moon (2026-01-18): from beyond the far side, the full Earth is behind the Moon.
    const blue = async (altitude: number) => {
      await open(page, APP, { doy: 17, tod: 12 }, { frames: 1 })
      await page.evaluate((alt) => {
        const s = (window as unknown as { __earthApp: { scene: any } }).__earthApp.scene
        const e = s.moon.position.clone().negate().normalize().applyMatrix3(s.moon.ecefToFixed)
        const lon = (Math.atan2(e.y, e.x) * 180) / Math.PI
        const lat = (Math.asin(e.z) * 180) / Math.PI
        s.camera.fov = 4
        s.camera.updateProjectionMatrix()
        window.__earth!.flyTo!('moon', { instant: true, longitude: lon + 180, latitude: -lat, altitude: alt })
        window.__earth!.renderFrames(2)
      }, altitude)
      return (await stats(page, (p, i) => p[i + 2]! > 60 && p[i + 2]! > p[i]! + 15)).count
    }
    expect(await blue(5e7)).toBe(0)
    expect(await blue(4e8)).toBeGreaterThan(500)
  })

  test('total solar eclipse, 2026-08-12, Burgos: the Moon covers the Sun', async ({ page }) => {
    const [lon, lat] = [-3.7, 42.34]
    const peak = SearchLocalSolarEclipse(new Date(Date.UTC(2026, 7, 1)), new Observer(lat, lon, 0)).peak.time.date.getTime()
    const sunCenter = async (moon: 'realistic' | 'takram') => {
      await open(page, APP, { lon, lat, alt: 900, ...localTime(peak, lon), clouds: 0, moon }, { frames: 1 })
      await page.evaluate(() => {
        window.__earth!.aim!(window.__earth!.sunDirection())
        window.__earth!.renderFrames(3)
      })
      const s = await page.evaluate(() => window.__earth!.projectSun())
      expect(Math.abs(s.x - W / 2)).toBeLessThan(2)
      return readPixels(page, W / 2 - 20, H / 2 - 20, 40, 40)
    }
    const saturated = (p: number[]) => {
      let n = 0
      for (let i = 0; i < p.length; i += 4) if (p[i]! >= 250 && p[i + 1]! >= 250 && p[i + 2]! >= 250) n++
      return n
    }
    // takram's sky disk ignores the Moon; the true-scale Moon hides the whole photosphere.
    expect(saturated(await sunCenter('takram'))).toBeGreaterThan(10)
    expect(saturated(await sunCenter('realistic'))).toBe(0)
  })

  test('total lunar eclipse, 2026-03-03: the Moon goes dark in the Earth’s umbra', async ({ page }) => {
    const peak = SearchLunarEclipse(new Date(Date.UTC(2026, 1, 15))).peak.date.getTime()
    const disk = async (ms: number) => {
      await open(page, APP, { ...localTime(ms, 30), focus: 'moon', moonAlt: 3e7 }, { frames: 2 })
      const s = await stats(page, (p, i) => luma(p, i) > 12) // above the dithering noise
      return s.mean * s.count
    }
    const normal = await disk(peak + 1.5 * DAY)
    const eclipsed = await disk(peak)
    expect(normal).toBeGreaterThan(80 * 100)
    expect(eclipsed).toBeLessThan(0.02 * normal)
  })
})
