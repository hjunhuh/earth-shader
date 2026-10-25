import { expect, test, type Browser, type Page } from '@playwright/test'
import { Geodetic } from '@takram/three-geospatial'
import { Vector3 } from 'three'
import { APP, diff, luma, open, readPixels, renderFrames } from './helpers'
import { MOUNTAIN, PLAIN, routeTiles, worldHeight, type Requests } from './tiles'

/** The terrain, on the synthetic world of tiles.ts. */
/** Render until every requested tile has loaded. */
async function settle(page: Page): Promise<void> {
  for (let i = 0; i < 200; ++i) {
    await renderFrames(page, 4)
    const progress = await page.evaluate(() => window.__earth!.terrainProgress!())
    if (progress >= 1 && i >= 8) break
    await page.waitForTimeout(50)
  }
  await renderFrames(page, 60) // Let the clouds/aerial-perspective history converge.
}

interface Shot {
  pixels: number[]
  requests: Requests
  attribution: boolean
}

async function shoot(
  browser: Browser,
  params: Record<string, string | number>,
  pov: [number, number, number],
  probe?: (page: Page) => Promise<void>,
): Promise<Shot> {
  const page = await browser.newPage()
  try {
    const requests = await routeTiles(page)
    await open(page, APP, { clouds: 0, terrain: 1, ...params }, { frames: 0 })
    await page.evaluate((p) => window.__earth!.setPointOfView(...p), pov)
    await settle(page)
    await probe?.(page)
    expect(await page.evaluate(() => window.__earth!.errors)).toEqual([])
    return { pixels: await readPixels(page), requests, attribution: await page.isVisible('#attribution') }
  } finally {
    await page.close()
  }
}

/** Mean absolute channel difference of two frames inside a screen rectangle. */
function regionDiff(a: number[], b: number[], x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0
  let n = 0
  for (let y = y0; y < y1; ++y) {
    for (let x = x0; x < x1; ++x) {
      const i = (y * 640 + x) * 4
      for (let c = 0; c < 3; ++c) sum += Math.abs(a[i + c]! - b[i + c]!)
      n += 3
    }
  }
  return sum / n
}

/** Mean luma of a screen rectangle (CSS px, 640×360 frame). */
function meanLuma(p: number[], x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0
  let n = 0
  for (let y = y0; y < y1; ++y) {
    for (let x = x0; x < x1; ++x) {
      sum += luma(p, (y * 640 + x) * 4)
      n++
    }
  }
  return sum / n
}

// Straight down over the summit from 15 km (the frame is ~23 × 41 km).
const TOP_DOWN: [number, number, number] = [0, -89.9, 15_000]
// Straight down from 40 km, for the sea.
const HIGH_DOWN: [number, number, number] = [0, -89.9, 40_000]
const SUMMIT = { lon: MOUNTAIN.lon, lat: MOUNTAIN.lat, alt: 0 }
// Morning: the Sun is in the east-southeast.
const MORNING = { tod: 9, doy: 170 }

test.describe('terrain', () => {
  test('relief is lit through the normal buffer: opposite flanks differ', async ({ browser }) => {
    // Exposure 3 keeps the land out of the tone curve's shoulder.
    const params = { ...SUMMIT, ...MORNING, exposure: 3 }
    const relief = await shoot(browser, params, TOP_DOWN)
    const flat = await shoot(browser, { ...params, exaggeration: 0 }, TOP_DOWN)
    // Flank pairs ~3.5 km either side of the summit, on both screen axes.
    const contrast = (p: number[]) => {
      const left = meanLuma(p, 245, 165, 275, 195)
      const right = meanLuma(p, 365, 165, 395, 195)
      const top = meanLuma(p, 305, 105, 335, 135)
      const bottom = meanLuma(p, 305, 225, 335, 255)
      return Math.max(Math.max(left, right) / Math.min(left, right), Math.max(top, bottom) / Math.min(top, bottom))
    }
    expect(contrast(relief.pixels), 'sunlit vs shaded flank').toBeGreaterThan(1.25)
    // Negative control: without relief both sides are lit alike.
    expect(contrast(flat.pixels)).toBeLessThan(1.05)
  })

  test('the mountain rises above the horizon and the camera stays above ground', async ({ browser }) => {
    // From ~8 km south at 500 m, looking north: the 3100 m summit stands ~18° up.
    const params = { lon: MOUNTAIN.lon, lat: MOUNTAIN.lat - 0.07, alt: 500, ...MORNING }
    const view: [number, number, number] = [90, 5, 1000] // north (PointOfView heading 0 faces east here)
    const tall = await shoot(browser, params, view, async (page) => {
      const summit = await page.evaluate(([lon, lat]) => window.__earth!.elevationAt!(lon!, lat!), [MOUNTAIN.lon, MOUNTAIN.lat])
      expect(summit).toBeGreaterThan(PLAIN + MOUNTAIN.height - 100)
      expect(summit).toBeLessThan(PLAIN + MOUNTAIN.height + 50)
    })
    const flat = await shoot(browser, { ...params, exaggeration: 0 }, view)
    // Above the horizon, around the screen center: sky without relief, rock with.
    expect(diff(tall.pixels, flat.pixels).over, 'the relief changes the frame').toBeGreaterThan(0.05)
    expect(regionDiff(tall.pixels, flat.pixels, 290, 140, 350, 170), 'mountain where the sky was').toBeGreaterThan(15)

    // A camera placed inside the mountain is lifted above its surface.
    await shoot(browser, SUMMIT, [0, -10, 1000], async (page) => {
      const c = await page.evaluate(() => window.__earth!.camera())
      const g = new Geodetic().setFromECEF(new Vector3(...(c.position as [number, number, number])))
      const ground = worldHeight((g.longitude * 180) / Math.PI, (g.latitude * 180) / Math.PI)
      expect(ground).toBeGreaterThan(PLAIN + MOUNTAIN.height / 2) // on the upper slopes
      expect(g.height).toBeGreaterThan(ground + 30 - 10) // 30 m clearance, less tile sampling error
    })
  })

  test('the sea is flat: bathymetry is clamped to sea level', async ({ browser }) => {
    // 80 km off the synthetic coast, so the whole frame is sea.
    const sea = { lon: 8.5, lat: 45, alt: 0, tod: 9, doy: 170 }
    const relief = await shoot(browser, sea, HIGH_DOWN)
    const flat = await shoot(browser, { ...sea, exaggeration: 0 }, HIGH_DOWN)
    const d = diff(relief.pixels, flat.pixels, 2)
    expect(d.mean, 'sea with vs without elevation').toBeLessThan(0.5)
    expect(d.over).toBeLessThan(0.01)
  })

  test('credits the map and elevation sources and stays within the elevation zooms', async ({ browser }) => {
    const on = await shoot(browser, { ...SUMMIT, alt: 300, ...MORNING }, [0, -30, 2000])
    expect(on.attribution).toBe(true)
    expect(on.requests.imagery).toBeGreaterThan(0)
    expect(on.requests.elevation).toBeGreaterThan(0)
    expect(on.requests.maxElevationZoom).toBeLessThanOrEqual(15)

    const page = await browser.newPage()
    try {
      const requests = await routeTiles(page)
      await open(page, APP, { terrain: 0, clouds: 0 }, { frames: 30 })
      expect(await page.isVisible('#attribution')).toBe(false)
      expect(requests.imagery + requests.elevation).toBe(0)
    } finally {
      await page.close()
    }
  })
})
