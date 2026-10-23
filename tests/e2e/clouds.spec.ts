import { expect, test, type Browser } from '@playwright/test'
import { APP, diff, luma, open, readPixels, renderFrames } from './helpers'

const LOOK_DOWN: [number, number, number] = [0, -40, 3000]

async function render(browser: Browser, params: Record<string, string | number>, pov?: [number, number, number]) {
  const page = await browser.newPage()
  try {
    await open(page, APP, params, { frames: pov ? 0 : 120 })
    if (pov) {
      await page.evaluate((p) => window.__earth!.setPointOfView(...p), pov)
      await renderFrames(page, 120)
    }
    return await readPixels(page)
  } finally {
    await page.close()
  }
}

/** Fraction of lower-half (ocean) pixels at least 15% darker with clouds than without: cloud shadows. */
function shadowFraction(withClouds: number[], without: number[]): number {
  let dark = 0
  let n = 0
  for (let y = 200; y < 360; ++y) {
    for (let x = 0; x < 640; ++x) {
      const i = (y * 640 + x) * 4
      const a = luma(withClouds, i)
      const b = luma(without, i)
      n++
      if (a < 0.85 * b) dark++
    }
  }
  return dark / n
}

test.describe('clouds', () => {
  test('cast shadows on the ocean; coverage 0 casts none (negative control)', async ({ browser }) => {
    const params = { tod: 12, coverage: 0.5 }
    const on = await render(browser, params, LOOK_DOWN)
    const off = await render(browser, { ...params, clouds: 0 }, LOOK_DOWN)
    const none = await render(browser, { ...params, coverage: 0 }, LOOK_DOWN)
    const shadows = shadowFraction(on, off)
    test.info().annotations.push({ type: 'shadow', description: `${(shadows * 100).toFixed(1)}% of the ocean is shadowed` })
    expect(shadows).toBeGreaterThan(0.03)
    expect(shadowFraction(none, off)).toBeLessThan(0.002)
  })

  test('toggling enabled at runtime gives the same frames as starting that way', async ({ page, browser }) => {
    const freshOff = await render(browser, { clouds: 0 })
    const freshOn = await render(browser, { clouds: 1 })
    await open(page, APP, { clouds: 1 })
    await page.evaluate(() => window.__earth!.setState!({ cloud: { enabled: false } }))
    await renderFrames(page, 120)
    expect(diff(await readPixels(page), freshOff).mean).toBeLessThan(0.01)
    await page.evaluate(() => window.__earth!.setState!({ cloud: { enabled: true } }))
    await renderFrames(page, 120)
    expect(diff(await readPixels(page), freshOn).mean).toBeLessThan(0.25)
    expect(await page.evaluate(() => window.__earth!.errors)).toEqual([])
  })

  test('every quality preset renders, and presets differ', async ({ browser }) => {
    const frames: number[][] = []
    for (const quality of ['low', 'medium', 'high', 'ultra']) frames.push(await render(browser, { quality, tod: 10 }))
    for (let i = 1; i < frames.length; ++i) expect(diff(frames[i]!, frames[i - 1]!).mean).toBeGreaterThan(0.05)
  })
})
