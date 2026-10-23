import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { openApp } from './helpers'

/**
 * L4 performance at 1920×1080 per quality preset over representative scenes.
 * Frame time = wall clock over N frames closed by a 1-pixel readPixels (a
 * full GPU sync; gl.finish() does not block on ANGLE/Metal). Per-pass timer
 * queries are recorded for reference only: on ANGLE/Metal they span
 * command-buffer boundaries and do not isolate passes. Budgets apply to the
 * worst scene; results go to bench-results/*.json.
 */
const SCENES: Record<string, Record<string, string | number>> = {
  space: { lon: 126.978, lat: 37.5665, alt: 15_000_000, tod: 8 },
  orbit: { lon: -30, lat: 5, alt: 400_000, tilt: 70, heading: 270, tod: 16.5 },
  overClouds: { lon: -30, lat: 5, alt: 30_000, tilt: 50, heading: 270, tod: 15 },
  sunsetLow: { lon: -30, lat: 5, alt: 2_600, tilt: 85, heading: 270, tod: 17.6 },
  inLayer: { lon: -30, lat: 5, alt: 1_600, tilt: 80, heading: 90, tod: 9 },
}
const BUDGET_MS: Record<string, number> = { low: 8, medium: 11, high: 16.7, ultra: 33 }

test.describe('L4 performance (1080p)', () => {
  for (const quality of ['low', 'medium', 'high', 'ultra'] as const) {
    test(`quality=${quality}`, async ({ page }) => {
      const results: Record<string, { frameMs: number; withoutCloudsMs: number }> = {}
      let worst = 0
      for (const [name, params] of Object.entries(SCENES)) {
        await openApp(page, { params: { ...params, quality }, width: 1920, height: 1080, frames: 8 })
        const r = await page.evaluate(() => {
          const e = window.__earth!
          const sync = () => e.readHdr(0, 0, 1, 1)
          e.renderFrames(16)
          sync()
          e.resetStats()
          const t0 = performance.now()
          e.renderFrames(60)
          sync()
          const frame = (performance.now() - t0) / 60
          e.setCloud({ enabled: false })
          e.renderFrames(4)
          sync()
          const t1 = performance.now()
          e.renderFrames(30)
          sync()
          const noClouds = (performance.now() - t1) / 30
          return { frame, noClouds, timerQueries: e.stats() }
        })
        results[name] = { frameMs: r.frame, withoutCloudsMs: r.noClouds, timerQueriesUnreliable: r.timerQueries } as never
        worst = Math.max(worst, r.frame)
      }
      mkdirSync('bench-results', { recursive: true })
      writeFileSync(`bench-results/${quality}.json`, JSON.stringify({ quality, resolution: '1920x1080', results }, null, 2))
      console.log(
        `[bench] ${quality}: ` +
          Object.entries(results)
            .map(([k, v]) => `${k}=${v.frameMs.toFixed(2)}ms (no clouds ${v.withoutCloudsMs.toFixed(2)})`)
            .join(' | '),
      )
      expect(worst, `${quality} worst-scene frame ${worst.toFixed(2)} ms`).toBeLessThan(BUDGET_MS[quality]!)
    })
  }
})
