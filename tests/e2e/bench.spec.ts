import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { APP, open } from './helpers'

/**
 * Frame time at 1920×1080 per cloud quality preset. Wall clock over 60
 * frames closed by a 1-pixel readPixels (a full GPU sync; gl.finish() does
 * not block on ANGLE/Metal). Results go to bench-results/<quality>.json.
 */
const SCENES: Record<string, { params: Record<string, string | number>; pov?: [number, number, number] }> = {
  storyView: { params: {} },
  noon: { params: { tod: 12 } },
  lookingDown: { params: { tod: 12, coverage: 0.6 }, pov: [0, -40, 3000] },
  sunset: { params: { tod: 16.8 }, pov: [-170, 3, 1000] },
}
const BUDGET_MS: Record<string, number> = { low: 8, medium: 11, high: 16.7, ultra: 33 }

test.describe('performance (1080p)', () => {
  for (const quality of ['low', 'medium', 'high', 'ultra'] as const) {
    test(`quality=${quality}`, async ({ page }) => {
      const results: Record<string, number> = {}
      for (const [name, scene] of Object.entries(SCENES)) {
        await open(page, APP, { ...scene.params, quality }, { width: 1920, height: 1080, frames: 8 })
        if (scene.pov) await page.evaluate((p) => window.__earth!.setPointOfView(...p), scene.pov)
        results[name] = await page.evaluate(() => {
          const e = window.__earth!
          const sync = () => e.readPixels(0, 0, 1, 1)
          e.renderFrames(16)
          sync()
          const t0 = performance.now()
          e.renderFrames(60)
          sync()
          return (performance.now() - t0) / 60
        })
      }
      const worst = Math.max(...Object.values(results))
      console.log(`[bench] ${quality}: ${Object.entries(results).map(([k, v]) => `${k}=${v.toFixed(2)}ms`).join(' | ')}`)
      mkdirSync('bench-results', { recursive: true })
      writeFileSync(`bench-results/${quality}.json`, JSON.stringify({ quality, results, worst }, null, 2))
      expect(worst).toBeLessThan(BUDGET_MS[quality]!)
    })
  }
})
