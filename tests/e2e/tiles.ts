import { crc32, deflateSync } from 'node:zlib'
import type { Page } from '@playwright/test'

/**
 * Local stand-ins for the imagery (EOX) and Terrarium elevation servers, so
 * e2e tests never fetch the real ones: deterministic, and no load on free
 * services. The synthetic world: a steep Gaussian mountain at 10°E 45°N on a
 * 100 m plain, a ridged seabed west of 9.5°E, land/sea colors to match.
 */
export const MOUNTAIN = { lon: 10, lat: 45, height: 3000, sigma: 0.03 } // ~3.3 km: slopes up to ~30°
export const PLAIN = 100
const COAST_LON = 9.5
const LAND = [0x8a, 0x86, 0x6c]
const WATER = [0x10, 0x1e, 0x3c]

export function worldHeight(lon: number, lat: number): number {
  // Seabed ridges, 500–2500 m deep: shaded relief if it weren't clamped.
  if (lon < COAST_LON) return -1500 + 1000 * Math.sin(lon * 60) * Math.cos(lat * 60)
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

export interface Requests {
  imagery: number
  elevation: number
  maxElevationZoom: number
}

export async function routeTiles(page: Page): Promise<Requests> {
  const requests: Requests = { imagery: 0, elevation: 0, maxElevationZoom: 0 }
  const cache = new Map<string, Buffer>()
  const zxy = (url: string) => url.match(/\/(\d+)\/(\d+)\/(\d+)\.png/)!.slice(1).map(Number) as [number, number, number]
  const zyx = (url: string) => url.match(/\/(\d+)\/(\d+)\/(\d+)\.jpg/)!.slice(1).map(Number) as [number, number, number]
  await page.route('https://tiles.maps.eox.at/**', (route) => {
    requests.imagery++
    const [z, y, x] = zyx(route.request().url())
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
