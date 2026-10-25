import { expect, type Page } from '@playwright/test'

export const APP = '/'
/** takram's Clouds/Basic story on the real React stack (tests/reference/takram.tsx). */
export const REF = '/tests/reference/takram.html'

export interface OpenOptions {
  width?: number
  height?: number
  frames?: number
  ui?: boolean
}

export async function open(
  page: Page,
  path: string,
  params: Record<string, string | number> = {},
  { width = 640, height = 360, frames = 120, ui = false }: OpenOptions = {},
): Promise<void> {
  await page.setViewportSize({ width, height })
  const query = new URLSearchParams({
    test: '1',
    // The terrain streams OSM/elevation tiles from the network; terrain.spec.ts
    // turns it on with local stand-ins.
    terrain: '0',
    frames: String(frames),
    size: `${width}x${height}`,
    ...(ui ? { ui: '1' } : {}),
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  })
  await page.goto(`${path}?${query}`)
  await page.waitForFunction(() => window.__earth?.ready === true, null, { timeout: 120_000 })
  expect(await page.evaluate(() => window.__earth!.errors)).toEqual([])
}

export const renderFrames = (page: Page, n: number) => page.evaluate((k) => window.__earth!.renderFrames(k), n)

export async function readPixels(page: Page, x = 0, y = 0, w?: number, h?: number): Promise<number[]> {
  return page.evaluate(
    ([x0, y0, w0, h0]) => {
      const e = window.__earth!
      const size = e.size()
      return e.readPixels(x0, y0, w0 ?? size.width, h0 ?? size.height)
    },
    [x, y, w, h] as const,
  )
}

export interface DiffStats {
  mean: number
  max: number
  /** Fraction of channel values that differ by more than `tolerance`. */
  over: number
}

export function diff(a: number[], b: number[], tolerance = 4): DiffStats {
  expect(a.length).toBe(b.length)
  let sum = 0
  let max = 0
  let over = 0
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; ++c) {
      const d = Math.abs(a[i + c]! - b[i + c]!)
      sum += d
      max = Math.max(max, d)
      if (d > tolerance) over++
      n++
    }
  }
  return { mean: sum / n, max, over: over / n }
}

/** Rec. 709 luma of 8-bit sRGB values (0–255). */
export const luma = (p: number[], i: number) => 0.2126 * p[i]! + 0.7152 * p[i + 1]! + 0.0722 * p[i + 2]!

export type CameraState = Awaited<ReturnType<NonNullable<Window['__earth']>['camera']>>
export const camera = (page: Page): Promise<CameraState> => page.evaluate(() => window.__earth!.camera())

export function cameraDistance(c: CameraState): number {
  return Math.hypot(c.position[0]! - c.target[0]!, c.position[1]! - c.target[1]!, c.position[2]! - c.target[2]!)
}
