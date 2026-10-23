import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { openApp } from './helpers'

/**
 * Secondary regression (plan L3, M8): representative scenes vs stored golden
 * PNGs, compared with windowed SSIM on luminance (≥ 0.98). Physical
 * correctness is covered by the measured tests; this only catches unintended
 * visual changes. Regenerate with UPDATE_GOLDEN=1 after intentional changes.
 */
const DIR = 'tests/e2e/__golden__'
const SCENES: Record<string, Record<string, string | number>> = {
  'space-morning': {},
  'full-disk-noon': { lon: -30, lat: 10, alt: 20_000_000, tod: 12 },
  'orbit-sunset': { lon: 127, lat: 20, alt: 400_000, tilt: 70, heading: 270, tod: 17.5 },
  'over-clouds': { lon: -30, lat: 5, alt: 30_000, tilt: 50, heading: 270, tod: 15 },
  'sea-sunset': { lon: 127, lat: 37.5, alt: 60, tilt: 86, heading: 270, tod: 17.9 },
  'dusk-afterglow': { lon: -30, lat: 20, alt: 200, tilt: 88, heading: 270, tod: 19 },
  'night-stars': { lon: -30, lat: 20, alt: 200, tilt: 88, heading: 0, tod: 23 },
  'overcast-reflection': { lon: 10, lat: 52, alt: 600, tilt: 82, heading: 250, tod: 17.3 },
  'cloud-sunset-sea': { lon: -30, lat: 48, alt: 300, tilt: 84, heading: 255, tod: 17.4 },
  'blob-shadow': { lon: 0, lat: 0, alt: 12_000, tilt: 0, tod: 10, weather: 'blob:0,0,1000,2500,1500' },
  'belt-of-venus': { lon: 127, lat: 37.5, alt: 60, tilt: 86, heading: 90, tod: 18.1, clouds: 0 },
  'terminator': { lon: 0, lat: 0, alt: 8_000_000, tod: 18 },
}

const ssimInPage = async ([a, b]: [string, string]): Promise<number> => {
  const decode = async (b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height)
    const y = new Float32Array(bmp.width * bmp.height)
    for (let i = 0; i < y.length; ++i) y[i] = 0.2126 * d.data[i * 4]! + 0.7152 * d.data[i * 4 + 1]! + 0.0722 * d.data[i * 4 + 2]!
    return { y, w: bmp.width, h: bmp.height }
  }
  const A = await decode(a)
  const B = await decode(b)
  if (A.w !== B.w || A.h !== B.h) return 0
  const C1 = (0.01 * 255) ** 2
  const C2 = (0.03 * 255) ** 2
  let sum = 0
  let n = 0
  for (let y0 = 0; y0 + 8 <= A.h; y0 += 4) {
    for (let x0 = 0; x0 + 8 <= A.w; x0 += 4) {
      let ma = 0, mb = 0
      for (let y = y0; y < y0 + 8; ++y) for (let x = x0; x < x0 + 8; ++x) { ma += A.y[y * A.w + x]!; mb += B.y[y * A.w + x]! }
      ma /= 64
      mb /= 64
      let va = 0, vb = 0, cov = 0
      for (let y = y0; y < y0 + 8; ++y) for (let x = x0; x < x0 + 8; ++x) {
        const da = A.y[y * A.w + x]! - ma
        const db = B.y[y * A.w + x]! - mb
        va += da * da
        vb += db * db
        cov += da * db
      }
      va /= 63
      vb /= 63
      cov /= 63
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
      n++
    }
  }
  return sum / n
}

test('SSIM discriminates different scenes (negative control)', async ({ page }) => {
  const a = `${DIR}/space-morning.png`
  const b = `${DIR}/full-disk-noon.png`
  test.skip(!existsSync(a) || !existsSync(b), 'goldens not generated yet')
  await page.goto('about:blank')
  const same = await page.evaluate(ssimInPage, [readFileSync(a).toString('base64'), readFileSync(a).toString('base64')] as [string, string])
  const diff = await page.evaluate(ssimInPage, [readFileSync(a).toString('base64'), readFileSync(b).toString('base64')] as [string, string])
  expect(same).toBeCloseTo(1, 6)
  expect(diff).toBeLessThan(0.9)
})

test.describe('golden images (SSIM ≥ 0.98)', () => {
  for (const [name, params] of Object.entries(SCENES)) {
    test(name, async ({ page }) => {
      await openApp(page, { params, width: 640, height: 360, frames: 48 })
      const shot = await page.locator('canvas').screenshot()
      const file = `${DIR}/${name}.png`
      if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
        mkdirSync(DIR, { recursive: true })
        writeFileSync(file, shot)
        test.info().annotations.push({ type: 'golden', description: `wrote ${file}` })
        return
      }
      const ref = readFileSync(file).toString('base64')
      const ssim = await page.evaluate(ssimInPage, [shot.toString("base64"), ref] as [string, string])
      if (ssim < 0.98) writeFileSync(`${DIR}/${name}.actual.png`, shot)
      expect(ssim, `${name}: SSIM ${(ssim as number).toFixed(4)}`).toBeGreaterThanOrEqual(0.98)
    })
  }
})
