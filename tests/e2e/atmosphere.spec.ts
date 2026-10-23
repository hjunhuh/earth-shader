import { expect, test, type Page } from '@playwright/test'
import { linearSrgbToXy, mccamyCct, SUN_SPECTRAL_RADIANCE_TO_LUMINANCE } from '../../src/atmosphere/luminance'
import { createEarthAtmosphere } from '../../src/atmosphere/AtmosphereParams'
import { solarPosition } from '../../src/time/solar'
import { timeOfDayAt } from '../../src/time/timeOfDay'
import {
  DAYLIGHT_ILLUMINANCE,
  DIRECT_SUN_CCT,
  TWILIGHT_ILLUMINANCE,
  krochmannZenith,
  preethamZenith,
} from '../fixtures/references'
import { openApp } from './helpers'

const DEG = Math.PI / 180
const dex = (a: number, b: number) => Math.log10(a / b)
const Y = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!

/** UTC instant on 2026-03-20 when the sun has the given elevation (evening branch). */
function utcForElevation(lat: number, lon: number, elevation: number, morning = false): number {
  const day = Date.UTC(2026, 2, 20)
  let best = { t: day, err: Infinity }
  for (let m = 0; m < 1440 * 2; m += 0.5) {
    const t = day - 12 * 3_600_000 + m * 60_000
    const p = solarPosition(t, lat, lon)
    const isMorning = p.hourAngle < 0
    if (isMorning !== morning) continue
    const err = Math.abs(90 - p.zenith - elevation)
    if (err < best.err) best = { t, err }
  }
  return best.t
}

async function api<T>(page: Page, fn: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([name, a]) => (window.__earth as never as Record<string, (...x: unknown[]) => unknown>)[name as string]!(...(a as unknown[])), [fn, args] as const) as Promise<T>
}

test.describe('atmosphere vs real-world measurements', () => {
  test('clear-sky horizontal illuminance vs solar elevation (±0.15 dex of published bands)', async ({ page }) => {
    await openApp(page)
    for (const ref of DAYLIGHT_ILLUMINANCE) {
      const { y } = await api<{ y: number }>(page, 'illuminance', Math.sin(ref.elevation * DEG))
      const d = y < ref.min ? dex(y, ref.min) : y > ref.max ? dex(y, ref.max) : 0
      expect(Math.abs(d), `${ref.elevation}°: ${y.toFixed(0)} lx`).toBeLessThan(0.15)
    }
  })

  test('twilight illuminance: sunset, civil, nautical (±0.4 dex of AMS values)', async ({ page }) => {
    await openApp(page)
    for (const ref of TWILIGHT_ILLUMINANCE) {
      const { y } = await api<{ y: number }>(page, 'illuminance', Math.sin(ref.elevation * DEG))
      const d = y < ref.min ? dex(y, ref.min) : y > ref.max ? dex(y, ref.max) : 0
      expect(Math.abs(d), `${ref.elevation}°: ${y.toPrecision(3)} lx`).toBeLessThan(0.4)
    }
  })

  test('clear-sky zenith luminance lies between Krochmann–Seidl and Preetham (T = 2.5), ×/÷1.5', async ({ page }) => {
    await openApp(page)
    for (const el of [60, 30, 15]) {
      const mu = Math.sin(el * DEG)
      const [c] = await api<number[][]>(page, 'probeSky', [{ altitude: 2, mu: 1, muS: mu, nu: mu }])
      const kcd = Y(c!) / 1000
      const lo = Math.min(krochmannZenith(2.5, el), preethamZenith(2.5, el)) / 1.5
      const hi = Math.max(krochmannZenith(2.5, el), preethamZenith(2.5, el)) * 1.5
      expect(kcd, `${el}°: ${kcd.toFixed(2)} kcd/m² not in [${lo.toFixed(2)}, ${hi.toFixed(2)}]`).toBeGreaterThan(lo)
      expect(kcd).toBeLessThan(hi)
    }
  })

  test('direct sunlight correlated color temperature vs elevation', async ({ page }) => {
    await openApp(page)
    for (const ref of DIRECT_SUN_CCT) {
      const rgb = await api<[number, number, number]>(page, 'directSun', Math.sin(ref.elevation * DEG))
      const cct = mccamyCct(linearSrgbToXy(rgb))
      expect(cct, `${ref.elevation}°: ${cct.toFixed(0)} K`).toBeGreaterThan(ref.min)
      expect(cct).toBeLessThan(ref.max)
    }
  })

  test('clear noon zenith sky is blue (hue 200°–240°)', async ({ page }) => {
    await openApp(page)
    const [c] = await api<number[][]>(page, 'probeSky', [{ altitude: 2, mu: 1, muS: Math.sin(55 * DEG), nu: Math.sin(55 * DEG) }])
    const [r, g, b] = c!.map((v) => v / Math.max(...c!))
    const max = Math.max(r!, g!, b!)
    const min = Math.min(r!, g!, b!)
    let hue = 0
    if (max === b) hue = 60 * ((r! - g!) / (max - min)) + 240
    else if (max === g) hue = 60 * ((b! - r!) / (max - min)) + 120
    else hue = (60 * ((g! - b!) / (max - min)) + 360) % 360
    expect(hue).toBeGreaterThan(200)
    expect(hue).toBeLessThan(240)
  })

  test('twilight zenith shifts toward blue as the sun sinks; removing ozone breaks it (negative control)', async ({ page, browser }) => {
    const chroma = async (p: Page) => {
      const qs = [-4, -8].map((el) => ({ altitude: 2, mu: 1, muS: Math.sin(el * DEG), nu: Math.sin(el * DEG) }))
      return (await api<number[][]>(p, 'probeSky', qs)).map((c) => linearSrgbToXy(c as [number, number, number]))
    }
    await openApp(page)
    const [a4, a8] = await chroma(page)
    // Chappuis-band ozone absorption makes the deep-twilight zenith bluer.
    expect(a8![0]).toBeLessThan(a4![0]! - 0.005)
    const other = await browser.newPage()
    await openApp(other, { params: { ozone: 0 } })
    const [, n8] = await chroma(other)
    expect(a8![0], 'ozone must make deep twilight bluer than an ozone-free sky').toBeLessThan(n8![0]! - 0.02)
    await other.close()
  })
})

test.describe('atmosphere: rendered-frame measurements', () => {
  test('sunset: the horizon sky around the sun is red (R/B > 1.5); at noon away from the sun it is not (< 1)', async ({ page }) => {
    const lat = 37.5
    const lon = 127
    const sunsetUtc = utcForElevation(lat, lon, 1.0)
    const az = solarPosition(sunsetUtc, lat, lon).azimuth
    const { width, height } = await openApp(page, {
      params: { lon, lat, alt: 50, tilt: 88, heading: az, tod: timeOfDayAt(sunsetUtc, lon), exposure: 8, clouds: 0 },
    })
    const ratio = async () => {
      // Sky rows just above the horizon, ±60 px around the sun column, excluding the disk.
      const d = await page.evaluate(([w, h]) => window.__earth!.readDistance(0, 0, w!, h!), [width, height])
      let horizon = 0
      for (let y = 0; y < height; ++y) if (d[y * width + width / 2]! < 0) horizon = y
      const rect = await page.evaluate(
        ([x, y, w, h]) => window.__earth!.readHdr(x!, y!, w!, h!),
        [width / 2 - 60, horizon - 12, 120, 10],
      )
      let r = 0
      let b = 0
      for (let i = 0; i < rect.length; i += 4) {
        if (Y([rect[i]!, rect[i + 1]!, rect[i + 2]!]) > 5000) continue // sun disk
        r += rect[i]!
        b += rect[i + 2]!
      }
      return r / b
    }
    expect(await ratio()).toBeGreaterThan(1.5)
    const noonUtc = utcForElevation(lat, lon, 52, true)
    await page.evaluate((tod) => window.__earth!.setTimeOfDay(tod), 12)
    await page.evaluate((h) => window.__earth!.setCamera({ heading: h }), 0) // look north, away from the sun
    await page.evaluate(() => window.__earth!.renderFrames(2))
    void noonUtc
    expect(await ratio()).toBeLessThan(1)
  })

  test("after sunset: Earth's shadow sits on the anti-solar horizon with a pink belt above it", async ({ page }) => {
    await openApp(page)
    // Sun at −2°: probe the anti-solar vertical (nu = −cos(el_view)·cos(el_sun) − ...).
    const sunEl = -2 * DEG
    const rows = [0.5, 1.5, 2.5, 4, 6, 8, 10, 12, 15, 20, 25].map((el) => {
      const mu = Math.sin(el * DEG)
      // Anti-solar azimuth: view and sun 180° apart in azimuth.
      const nu = -Math.cos(el * DEG) * Math.cos(sunEl) + mu * Math.sin(sunEl)
      return { el, q: { altitude: 2, mu, muS: Math.sin(sunEl), nu } }
    })
    const out = await api<number[][]>(page, 'probeSky', rows.map((r) => r.q))
    const rb = out.map((c) => c[0]! / c[2]!)
    const shadowRb = Math.max(rb[0]!, rb[1]!)
    const beltRb = Math.max(...rb.slice(4, 9))
    expect(beltRb, `belt R/B ${beltRb.toFixed(3)} vs shadow ${shadowRb.toFixed(3)}`).toBeGreaterThan(shadowRb + 0.05)
  })

  test('terminator: rendered ocean luminance tracks the CPU illuminance model across the day/night line (8,000 km)', async ({ page }) => {
    // tod 18 at lon 0 (equinox): the terminator passes through the sub-camera
    // point. Sun elevations come from the CPU solar ephemeris per pixel; E(el)
    // from the CPU illuminance model falls ~0.26 dex/° here, so any terminator
    // misplacement ≳1.5° makes L/E jump. L must also fall monotonically.
    const { width, height } = await openApp(page, { params: { lon: 0, lat: 0, alt: 8_000_000, tod: 18, exposure: 14, clouds: 0 } })
    const y = Math.floor(height / 2)
    const row = await page.evaluate(([w, yy]) => window.__earth!.readHdr(0, yy!, w!, 1), [width, y])
    const samples: { el: number; L: number; E: number }[] = []
    for (let x = 0; x < width; ++x) {
      const el = await page.evaluate(([xx, yy]) => window.__earth!.sunElevationAt(xx!, yy!), [x, y])
      if (el === null || el < -6 || el > 3) continue
      const { y: E } = await api<{ y: number }>(page, 'illuminance', Math.sin(el * DEG))
      samples.push({ el, L: Y([row[x * 4]!, row[x * 4 + 1]!, row[x * 4 + 2]!]), E })
    }
    expect(samples.length).toBeGreaterThan(20)
    const logRatio = samples.map((s) => Math.log10(s.L / s.E))
    const spread = Math.max(...logRatio) - Math.min(...logRatio)
    expect(spread, `log10(L/E) spread ${spread.toFixed(3)} dex`).toBeLessThan(0.45)
    const sorted = [...samples].sort((a, b) => b.el - a.el)
    for (let i = 1; i < sorted.length; ++i) expect(sorted[i]!.L).toBeLessThanOrEqual(sorted[i - 1]!.L * 1.02)
  })

  test('ocean seen from geostationary orbit outside the glint: TOA reflectance 0.03–0.12 (550 nm)', async ({ page }) => {
    // Sun at 45° elevation at the sub-camera point (tod 9 at lon 0, equinox).
    const { width, height } = await openApp(page, { params: { lon: 0, lat: 0, alt: 35_786_000, tod: 9, exposure: 14, clouds: 0 } })
    const px = await page.evaluate(([w, h]) => window.__earth!.readHdr(w! / 2 - 2, h! / 2 - 2, 4, 4), [width, height])
    let g = 0
    for (let i = 0; i < px.length; i += 4) g += px[i + 1]!
    g = (g / (px.length / 4)) * 1000 // kcd/m² -> cd/m²
    const p = createEarthAtmosphere()
    const e0g = p.solarIrradiance[1] * SUN_SPECTRAL_RADIANCE_TO_LUMINANCE[1]
    const mu0 = Math.cos(45 * DEG)
    const reflectance = (Math.PI * g) / (e0g * mu0)
    expect(reflectance).toBeGreaterThan(0.03)
    expect(reflectance).toBeLessThan(0.12)
  })
})
