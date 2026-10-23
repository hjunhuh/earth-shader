import { expect, test, type Browser } from '@playwright/test'
import { open, readPixels, renderFrames } from './helpers'

/**
 * The realistic sun as seen on screen (the user-visible complaint was a
 * pixelated sun). Measured on the final 8-bit frame around the projected sun.
 */
interface Blob {
  area: number // CSS px²
  radius: number // equivalent radius sqrt(area/π), CSS px
  compactness: number // area / (π · max radius²): 1 for a disk, 0.64 for a square's circumcircle
  aspect: number // x extent / y extent
  core: number[]
}

async function sunBlob(browser: Browser, params: Record<string, string | number>, pov: [number, number, number], dpr = 1): Promise<Blob & { inFront: boolean }> {
  const context = await browser.newContext({ deviceScaleFactor: dpr })
  const page = await context.newPage()
  await open(page, '/', { ...params, dpr }, { frames: 0 })
  await page.evaluate((p) => window.__earth!.setPointOfView(...p), pov)
  await renderFrames(page, 60)
  const s = await page.evaluate(() => window.__earth!.projectSun())
  const half = 60
  const x0 = Math.round(s.x - half)
  const y0 = Math.round(s.y - half)
  const px = await readPixels(page, x0, y0, 2 * half, 2 * half)
  await context.close()
  const n = 2 * half * dpr
  let area = 0
  let sx = 0
  let sy = 0
  const pts: [number, number][] = []
  for (let y = 0; y < n; ++y) {
    for (let x = 0; x < n; ++x) {
      const i = (y * n + x) * 4
      if (px[i]! >= 250 && px[i + 1]! >= 250 && px[i + 2]! >= 245) {
        area++
        sx += x
        sy += y
        pts.push([x, y])
      }
    }
  }
  const cx = sx / Math.max(1, area)
  const cy = sy / Math.max(1, area)
  let rmax = 0
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [x, y] of pts) {
    rmax = Math.max(rmax, Math.hypot(x + 0.5 - (cx + 0.5), y + 0.5 - (cy + 0.5)) + 0.5)
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  const ci = (Math.round(cy) * n + Math.round(cx)) * 4
  return {
    inFront: s.inFront,
    area: area / (dpr * dpr),
    radius: Math.sqrt(area / Math.PI) / dpr,
    compactness: area / (Math.PI * rmax * rmax),
    aspect: (maxX - minX + 1) / (maxY - minY + 1),
    core: px.slice(ci, ci + 3),
  }
}

const MORNING = { params: { tod: 8, clouds: 0 }, pov: [-35, 5, 1000] as [number, number, number] }

test.describe('realistic sun on screen', () => {
  test('is a round glowing disk, not a block of pixels (DPR 1), unlike takram’s disk', async ({ browser }) => {
    const sun = await sunBlob(browser, MORNING.params, MORNING.pov)
    const takram = await sunBlob(browser, { ...MORNING.params, sun: 'takram' }, MORNING.pov)
    console.log('[sun] realistic', JSON.stringify(sun), '\n[sun] takram', JSON.stringify(takram))
    expect(sun.inFront).toBe(true)
    // Glare makes the saturated core several pixels across and round.
    expect(sun.radius).toBeGreaterThan(4)
    expect(sun.compactness).toBeGreaterThan(0.8)
    expect(Math.abs(sun.aspect - 1)).toBeLessThan(0.15)
    // takram's disk saturates a few pixels only (the reported pixelation).
    expect(takram.radius).toBeLessThan(2.5)
  })

  test('looks the same at DPR 1 and DPR 2 (resolution independent)', async ({ browser }) => {
    const a = await sunBlob(browser, MORNING.params, MORNING.pov, 1)
    const b = await sunBlob(browser, MORNING.params, MORNING.pov, 2)
    console.log('[sun] dpr1', a.radius.toFixed(2), 'dpr2', b.radius.toFixed(2))
    expect(Math.abs(a.radius - b.radius) / a.radius).toBeLessThan(0.12)
    expect(b.compactness).toBeGreaterThan(0.85)
  })

  test('more glare → larger bloom; no glare → the bare disk', async ({ browser }) => {
    const r: number[] = []
    for (const glare of [0, 0.05, 0.1, 0.2, 0.4]) r.push((await sunBlob(browser, { ...MORNING.params, glare }, MORNING.pov)).radius)
    console.log('[sun] radius vs glare', r.map((v) => v.toFixed(2)).join(' '))
    for (let i = 1; i < r.length; ++i) expect(r[i]!).toBeGreaterThan(r[i - 1]!)
    expect(r[0]!).toBeLessThan(2.5)
  })

  test('a setting sun is redder and its glow smaller than in the morning', async ({ browser }) => {
    const sunset = await sunBlob(browser, { tod: 16.8, clouds: 0 }, [-170, 3, 1000])
    const morning = await sunBlob(browser, MORNING.params, MORNING.pov)
    console.log('[sun] sunset', JSON.stringify(sunset))
    expect(sunset.radius).toBeLessThan(morning.radius)
  })

  test('behind thick clouds it disappears: no disk, no glare (clear sky as control)', async ({ browser }) => {
    // Looking south at the noon sun from ~580 m (target at 1 km; OrbitControls keeps ≥ 1000 m from it).
    const pov: [number, number, number] = [-90, 25, 1000]
    const measure = async (params: Record<string, string | number>) => {
      const page = await browser.newPage()
      await open(page, '/', { tod: 12, alt: 1000, ...params }, { frames: 0 })
      await page.evaluate((p) => window.__earth!.setPointOfView(...p), pov)
      await renderFrames(page, 60)
      const visibility = await page.evaluate(() => {
        const sc = (window as any).__earthApp.scene
        const out = new Float32Array(4)
        sc.renderer.readRenderTargetPixels(sc.sun.visibilityTarget, 0, 0, 1, 1, out)
        return out[0]
      })
      const blob = await sunBlobOnPage(page)
      await page.close()
      return { visibility, blob }
    }
    const overcast = await measure({ coverage: 1 })
    const clear = await measure({ clouds: 0 })
    console.log('[sun] overcast', JSON.stringify(overcast), 'clear', JSON.stringify(clear))
    expect(clear.visibility).toBeGreaterThan(0.99)
    expect(clear.blob).toBeGreaterThan(50)
    expect(overcast.visibility).toBeLessThan(0.05)
    expect(overcast.blob).toBe(0)
  })
})

/** Saturated pixels within 60 px of the projected sun. */
async function sunBlobOnPage(page: import('@playwright/test').Page): Promise<number> {
  const s = await page.evaluate(() => window.__earth!.projectSun())
  const px = await readPixels(page, Math.round(s.x - 60), Math.round(s.y - 60), 120, 120)
  let n = 0
  for (let i = 0; i < px.length; i += 4) if (px[i]! >= 250 && px[i + 1]! >= 250 && px[i + 2]! >= 245) n++
  return n
}
