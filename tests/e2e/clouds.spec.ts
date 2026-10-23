import { expect, test, type Page } from '@playwright/test'
import { solarPosition } from '../../src/time/solar'
import { timeOfDayAt } from '../../src/time/timeOfDay'
import { openApp } from './helpers'

const DEG = Math.PI / 180
const Y = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
const lacisHansen = (tau: number) => (0.13 * tau) / (1 + 0.13 * tau)

/** UTC on 2026-03-20 when the sun at (lat, lon) has the given elevation. */
function utcForElevation(lat: number, lon: number, elevation: number, morning: boolean): number {
  const day = Date.UTC(2026, 2, 20)
  let best = { t: day, err: Infinity }
  for (let m = 0; m < 2880; m += 0.25) {
    const t = day - 12 * 3_600_000 + m * 60_000
    const p = solarPosition(t, lat, lon)
    if (p.hourAngle < 0 !== morning) continue
    const err = Math.abs(90 - p.zenith - elevation)
    if (err < best.err) best = { t, err }
  }
  return best.t
}
const todFor = (lat: number, lon: number, elevation: number, morning: boolean) =>
  timeOfDayAt(utcForElevation(lat, lon, elevation, morning), lon)

async function cloudCenter(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const e = window.__earth!
    const s = e.cloudSize()
    const c = e.readClouds(Math.floor(s.width / 2) - 2, Math.floor(s.height / 2) - 2, 4, 4)
    const out = [0, 0, 0, 0]
    for (let i = 0; i < c.length; ++i) out[i % 4] += c[i]! / 16
    return out
  })
}

test.describe('clouds: measured', () => {
  test('cloud reflectance follows Lacis–Hansen for slabs τ = 5…50 (±0.1, sun near zenith)', async ({ page }) => {
    for (const tau of [5, 10, 20, 50]) {
      await openApp(page, { params: { lon: 0, lat: 0, alt: 20_000, tilt: 0, tod: 12, weather: `slab:${tau},1000,2000`, physical: 1 } })
      const c = await cloudCenter(page)
      const sun = await page.evaluate(() => window.__earth!.directSun(Math.sin(88 * (Math.PI / 180)), 2000))
      const R = (Math.PI * Y(c) * 1000) / Y(sun)
      expect(Math.abs(R - lacisHansen(tau)), `τ=${tau}: R=${R.toFixed(3)} vs ${lacisHansen(tau).toFixed(3)}`).toBeLessThan(0.1)
    }
  })

  test('8 km cloud tops keep a red direct-sun glow until the sun nears the geometric dip −√(2h/R) = −2.87°', async ({ page }) => {
    // Sweep the sun elevation across the dip of an 8 km cloud top. Direct
    // sunlight (strongly reddened, R/G ≈ 4) fades as the grazing ray sinks
    // into dense air and is gone at the geometric dip; below it only the
    // twilight sky lights the cloud (R/G ≈ 2). The knee must sit within
    // [dip − 0.25°, dip + 0.75°].
    const top = 8000
    const dip = Math.sqrt((2 * top) / 6378137) / DEG
    const sweep: { d: number; L: number; rg: number }[] = []
    for (let d = 1.5; d >= -1.0; d -= 0.25) {
      const tod = todFor(0, 0, -dip + d, false)
      await openApp(page, { params: { lon: 0, lat: 0, alt: top + 12_000, tilt: 0, tod, weather: `blob:0,0,7600,${top},4000`, physical: 1, exposure: 4 }, frames: 1 })
      const c = await cloudCenter(page)
      sweep.push({ d, L: Y(c), rg: c[0]! / c[1]! })
    }
    const peak = Math.max(...sweep.map((s) => s.rg))
    const floor = sweep[sweep.length - 1]!.rg
    expect(peak, 'direct sunlight near the dip is strongly reddened').toBeGreaterThan(3)
    const mid = (peak + floor) / 2
    let knee = NaN
    for (let i = 1; i < sweep.length; ++i) {
      if (sweep[i - 1]!.rg >= mid && sweep[i]!.rg < mid) knee = (sweep[i - 1]!.d + sweep[i]!.d) / 2
    }
    expect(knee, `knee at dip ${knee >= 0 ? '+' : ''}${knee.toFixed(2)}°`).toBeGreaterThan(-0.25)
    expect(knee).toBeLessThan(0.75)
    // Brightness falls monotonically through the dip.
    for (let i = 1; i < sweep.length; ++i) expect(sweep[i]!.L).toBeLessThanOrEqual(sweep[i - 1]!.L * 1.02)
  })

  test('1.5 km cloud tops dim monotonically and stay reddened through their dip (−1.24°)', async ({ page }) => {
    const top = 1500
    const dip = Math.sqrt((2 * top) / 6378137) / DEG
    let prev = Infinity
    for (const d of [1.0, 0.5, 0, -0.5, -1.0]) {
      const tod = todFor(0, 0, -dip + d, false)
      await openApp(page, { params: { lon: 0, lat: 0, alt: top + 12_000, tilt: 0, tod, weather: `blob:0,0,1100,${top},4000`, physical: 1, exposure: 4 }, frames: 1 })
      const c = await cloudCenter(page)
      expect(Y(c)).toBeLessThan(prev * 1.02)
      expect(c[0]! / c[1]!).toBeGreaterThan(1.3)
      prev = Y(c)
    }
  })

  test('cloud shadows land h/tan(e) away toward the anti-solar azimuth; shadows off removes them (negative control)', async ({ page }) => {
    const measureShadow = async (elevation: number) => {
      const tod = todFor(0, 0, elevation, true) // morning: sun in the east
      await openApp(page, { params: { lon: 0, lat: 0, alt: 12_000, tilt: 0, tod, weather: 'blob:0,0,1000,2500,1500' } })
      return page.evaluate(() => {
        const e = window.__earth!
        const { width, height } = e.size()
        const lit = e.readBackground(0, 0, width, height)
        e.setDebug({ shadows: false })
        e.renderFrames(1)
        const unshadowed = e.readBackground(0, 0, width, height)
        e.setDebug({ shadows: true })
        e.renderFrames(1)
        let n = 0
        let lat = 0
        let lon = 0
        for (let y = 0; y < height; y += 2) {
          for (let x = 0; x < width; x += 2) {
            const i = (y * width + x) * 4
            const a = 0.2126 * lit[i]! + 0.7152 * lit[i + 1]! + 0.0722 * lit[i + 2]!
            const b = 0.2126 * unshadowed[i]! + 0.7152 * unshadowed[i + 1]! + 0.0722 * unshadowed[i + 2]!
            if (b > 0 && a < 0.9 * b) {
              const g = e.pick(x, y)
              if (!g) continue
              lat += g.lat
              lon += g.lon
              n++
            }
          }
        }
        return { n, lat: lat / Math.max(n, 1), lon: lon / Math.max(n, 1) }
      })
    }
    for (const elevation of [60, 30]) {
      const s = await measureShadow(elevation)
      expect(s.n, 'shadow pixels').toBeGreaterThan(50)
      const east = s.lon * DEG * 6378137
      const north = s.lat * DEG * 6378137
      const dist = Math.hypot(east, north)
      const azimuth = ((Math.atan2(east, north) / DEG) + 360) % 360
      const expected = 1750 / Math.tan(elevation * DEG)
      const sunAz = solarPosition(utcForElevation(0, 0, elevation, true), 0, 0).azimuth
      expect(Math.abs(dist - expected) / expected, `e=${elevation}°: offset ${dist.toFixed(0)} m vs ${expected.toFixed(0)} m`).toBeLessThan(0.2)
      expect(Math.abs((((azimuth - (sunAz + 180)) % 360) + 540) % 360 - 180), `azimuth ${azimuth.toFixed(1)}°`).toBeLessThan(15)
    }
    // Negative control: with shadows disabled no pixel is darkened.
    await openApp(page, { params: { lon: 0, lat: 0, alt: 12_000, tilt: 0, tod: 10, weather: 'blob:0,0,1000,2500,1500', shadows: 0 } })
    const none = await page.evaluate(() => {
      const e = window.__earth!
      const { width, height } = e.size()
      const a = e.readBackground(0, 0, width, height)
      e.setDebug({ shadows: false })
      e.renderFrames(1)
      const b = e.readBackground(0, 0, width, height)
      let n = 0
      for (let i = 0; i < a.length; i += 4) if (a[i + 1]! < 0.9 * b[i + 1]!) n++
      return n
    })
    expect(none).toBe(0)
  })

  test('light shafts: air in a cloud shadow stops scattering sunlight (clear sky as negative control)', async ({ page }) => {
    // Camera 12 km east of a blob, inside its shadow volume (sun 8° high in
    // the west), looking west just below the cloud: those sky rays cross
    // shadowed air. Toggling shadows (which drives the shafts) must darken
    // them; with clear weather it must change nothing.
    const tod = todFor(0, 0, 8, false)
    const measure = async (weather: string) => {
      await openApp(page, { params: { lon: 0.108, lat: 0, alt: 300, tilt: 88, heading: 270, tod, weather, quality: 'high' } })
      return page.evaluate(() => {
        const e = window.__earth!
        const { width, height } = e.size()
        const d = e.readDistance(width / 2, 0, 1, height)
        let horizon = 0
        for (let y = 0; y < height; ++y) if (d[y]! < 0) horizon = y
        const y = horizon - 4
        const lum = () => {
          const p = e.readBackground(width / 2 - 2, y, 4, 1)
          let s = 0
          for (let i = 0; i < p.length; i += 4) s += 0.2126 * p[i]! + 0.7152 * p[i + 1]! + 0.0722 * p[i + 2]!
          return s
        }
        const withShafts = lum()
        e.setDebug({ shadows: false })
        e.renderFrames(2)
        const without = lum()
        return { withShafts, without }
      })
    }
    const blob = await measure('blob:0,0,1000,2500,3000')
    expect(blob.withShafts, `shadowed sky ${blob.withShafts.toFixed(2)} vs unshadowed ${blob.without.toFixed(2)}`).toBeLessThan(0.95 * blob.without)
    const clear = await measure('clear')
    expect(Math.abs(clear.withShafts - clear.without) / clear.without).toBeLessThan(0.005)
  })

  test('clouds off: no cloud alpha, no cloud pass time, final HDR equals the background', async ({ page }) => {
    await openApp(page, { params: { lon: -30, lat: 10, alt: 20_000_000, tod: 12, clouds: 0 } })
    const r = await page.evaluate(() => {
      const e = window.__earth!
      e.resetStats()
      e.renderFrames(8)
      const s = e.cloudSize()
      const c = e.readClouds(0, 0, s.width, s.height)
      let maxA = 0
      for (let i = 3; i < c.length; i += 4) maxA = Math.max(maxA, c[i]!)
      const hdr = e.readHdr(300, 160, 40, 40)
      const bg = e.readBackground(300, 160, 40, 40)
      let diff = 0
      for (let i = 0; i < hdr.length; ++i) diff = Math.max(diff, Math.abs(hdr[i]! - bg[i]!))
      return { maxA, diff, stats: e.stats() }
    })
    expect(r.maxA).toBe(0)
    expect(r.diff).toBeLessThan(1e-3)
    expect(r.stats.clouds).toBeUndefined()
  })
})
