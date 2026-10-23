import { expect, test, type Browser } from '@playwright/test'
import { APP, diff, open, readPixels, REF, renderFrames } from './helpers'

/**
 * The rendering must be takram's: every scene is rendered by the app and by
 * the takram reference page (Clouds/Basic on R3F + drei + postprocessing)
 * with identical inputs, and the final 8-bit frames are compared.
 */
interface Scene {
  params: Record<string, string | number>
  /** Optional PointOfView applied on both pages after loading (heading°, pitch°, distance m). */
  pov?: [number, number, number]
  /** The sun must be on screen in this view. */
  sun?: boolean
}

const SCENES: Record<string, Scene> = {
  'story view, 08:00': { params: {} },
  'story view, noon': { params: { tod: 12 } },
  'story view, 16:30': { params: { tod: 16.5 } },
  'looking into the morning sun': { params: { tod: 8 }, pov: [-35, 5, 1000], sun: true },
  'sunset toward the sun': { params: { tod: 16.8 }, pov: [-170, 3, 1000], sun: true },
  'clouds off': { params: { clouds: 0 } },
  'quality low': { params: { quality: 'low', tod: 10 } },
  'quality ultra': { params: { quality: 'ultra', tod: 10 } },
  'coverage 0.6, looking down': { params: { coverage: 0.6, tod: 12 }, pov: [0, -40, 3000] },
  'Seoul, 1 km, 17:00, day 170': { params: { lon: 127, lat: 37.5, alt: 1000, doy: 170, tod: 17 } },
}

async function render(browser: Browser, path: string, scene: Scene): Promise<number[]> {
  const page = await browser.newPage()
  try {
    await open(page, path, scene.params, { frames: scene.pov ? 0 : 120 })
    if (scene.pov) {
      await page.evaluate((p) => window.__earth!.setPointOfView(...p), scene.pov)
      await renderFrames(page, 120)
    }
    if (scene.sun) {
      const s = await page.evaluate(() => window.__earth!.projectSun())
      expect(s.inFront && s.x > 0 && s.x < 640 && s.y > 0 && s.y < 360, `sun at ${s.x}, ${s.y}`).toBe(true)
    }
    return await readPixels(page)
  } finally {
    await page.close()
  }
}

test.describe('rendering matches takram Clouds/Basic', () => {
  for (const [name, scene] of Object.entries(SCENES)) {
    test(name, async ({ browser }) => {
      const app = await render(browser, APP, scene)
      const ref = await render(browser, REF, scene)
      const d = diff(app, ref)
      const summary = `mean ${d.mean.toFixed(4)}, max ${d.max}, >4/255: ${(d.over * 100).toFixed(3)}%`
      test.info().annotations.push({ type: 'diff', description: summary })
      console.log(`[parity] ${name}: ${summary}`)
      expect(d.mean, `mean |app − takram| = ${d.mean}`).toBeLessThan(0.25)
      expect(d.over, `fraction of values off by more than 4/255`).toBeLessThan(0.001)
    })
  }

  test('negative control: the comparison catches a 6-minute time shift and a 0.5 EV exposure change', async ({ browser }) => {
    const base = await render(browser, REF, { params: { tod: 8 } })
    const shifted = await render(browser, APP, { params: { tod: 8.1 } })
    const brighter = await render(browser, APP, { params: { tod: 8, exposure: 10 * Math.SQRT2 } })
    expect(diff(base, shifted).mean).toBeGreaterThan(0.25)
    expect(diff(base, brighter).mean).toBeGreaterThan(2)
  })
})
