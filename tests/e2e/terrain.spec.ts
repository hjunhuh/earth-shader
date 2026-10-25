import { crc32, deflateSync } from 'node:zlib'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { Geodetic } from '@takram/three-geospatial'
import { Vector3 } from 'three'
import { APP, diff, luma, open, readPixels, renderFrames } from './helpers'

/**
 * The terrain with local stand-ins for the OSM and Terrarium servers (never the
 * real ones: deterministic, and the OSM tile policy forbids automated bulk
 * fetching). The synthetic world: a steep Gaussian mountain at 10°E 45°N on a 100 m
 * plain, sea 1000 m deep west of 9.5°E, OSM land/water colors to match.
 */
const MOUNTAIN = { lon: 10, lat: 45, height: 3000, sigma: 0.03 } // ~3.3 km: slopes up to ~30°
const PLAIN = 100
const COAST_LON = 9.5
const LAND = [0xf2, 0xef, 0xe9]
const WATER = [0xaa, 0xd3, 0xdf]

function worldHeight(lon: number, lat: number): number {
  if (lon < COAST_LON) return -1000
  const dx = (lon - MOUNTAIN.lon) * Math.cos((MOUNTAIN.lat * Math.PI) / 180)
  const dy = lat - MOUNTAIN.lat
  return PLAIN + MOUNTAIN.height * Math.exp(-(dx * dx + dy * dy) / (2 * MOUNTAIN.sigma ** 2))
}

/** Pixel center of a 256-px Web Mercator tile → lon/lat in degrees. */
function pixelLonLat(z: number, x: number, y: number, px: number, py: number): [number, number] {
  const n = 2 ** z
  const lon = ((x + (px + 0.5) / 256) / n) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (py + 0.5) / 256)) / n))) * 180) / Math.PI
  return [lon, lat]
}

function png(width: number, height: number, rgb: (px: number, py: number) => number[]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let py = 0; py < height; ++py) {
    raw[py * (width * 3 + 1)] = 0 // filter: none
    for (let px = 0; px < width; ++px) raw.set(rgb(px, py), py * (width * 3 + 1) + 1 + px * 3)
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const terrarium = (h: number) => {
  const v = h + 32768
  return [Math.floor(v / 256), Math.floor(v) % 256, Math.floor((v % 1) * 256)]
}

interface Requests {
  imagery: number
  elevation: number
  maxElevationZoom: number
}

async function routeTiles(page: Page): Promise<Requests> {
  const requests: Requests = { imagery: 0, elevation: 0, maxElevationZoom: 0 }
  const cache = new Map<string, Buffer>()
  const zxy = (url: string) => url.match(/\/(\d+)\/(\d+)\/(\d+)\.png/)!.slice(1).map(Number) as [number, number, number]
  await page.route('https://tile.openstreetmap.org/**', (route) => {
    requests.imagery++
    const [z, x, y] = zxy(route.request().url())
    const key = `i${z}/${x}/${y}`
    if (!cache.has(key)) cache.set(key, png(256, 256, (px, py) => (pixelLonLat(z, x, y, px, py)[0] < COAST_LON ? WATER : LAND)))
    return route.fulfill({ contentType: 'image/png', body: cache.get(key)!, headers: { 'access-control-allow-origin': '*' } })
  })
  await page.route('https://s3.amazonaws.com/elevation-tiles-prod/**', (route) => {
    requests.elevation++
    const [z, x, y] = zxy(route.request().url())
    requests.maxElevationZoom = Math.max(requests.maxElevationZoom, z)
    const key = `e${z}/${x}/${y}`
    if (!cache.has(key)) cache.set(key, png(256, 256, (px, py) => terrarium(worldHeight(...pixelLonLat(z, x, y, px, py)))))
    return route.fulfill({ contentType: 'image/png', body: cache.get(key)!, headers: { 'access-control-allow-origin': '*' } })
  })
  return requests
}

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

  test('the sea is flat and keeps the ocean’s look', async ({ browser }) => {
    // Over the synthetic sea (1000 m deep in the elevation data).
    // 80 km off the synthetic coast, so the whole frame is sea.
    const sea = { lon: 8.5, lat: 45, alt: 0, tod: 12, doy: 170 }
    const terrain = await shoot(browser, sea, HIGH_DOWN)
    const ocean = await shoot(browser, { ...sea, terrain: 0 }, HIGH_DOWN)
    const d = diff(terrain.pixels, ocean.pixels, 6)
    expect(d.mean, 'terrain sea vs ray-traced ocean').toBeLessThan(3)
    expect(d.over).toBeLessThan(0.02)
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
