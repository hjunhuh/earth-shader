import { expect, type Page } from '@playwright/test'

export interface OpenOptions {
  params?: Record<string, string | number>
  width?: number
  height?: number
  frames?: number
}

/** Opens the app in deterministic test mode and waits for convergence. */
export async function openApp(page: Page, opts: OpenOptions = {}): Promise<{ width: number; height: number }> {
  const width = opts.width ?? 640
  const height = opts.height ?? 360
  await page.setViewportSize({ width, height })
  const query = new URLSearchParams({
    test: '1',
    size: `${width}x${height}`,
    frames: String(opts.frames ?? 32),
    seed: '1',
    wind: '0',
    ...Object.fromEntries(Object.entries(opts.params ?? {}).map(([k, v]) => [k, String(v)])),
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text())
  })
  await page.goto(`/?${query.toString()}`)
  await page.waitForFunction(() => window.__earth?.ready === true, null, { timeout: 120_000 })
  expect(errors, 'page errors').toEqual([])
  return { width, height }
}

/** Linear HDR rgba (kcd/m²) of a rect, top-left origin. */
export async function readHdr(page: Page, x: number, y: number, w: number, h: number): Promise<Float32Array> {
  const data = await page.evaluate(([a, b, c, d]) => window.__earth!.readHdr(a!, b!, c!, d!), [x, y, w, h])
  return Float32Array.from(data)
}

export async function renderFrames(page: Page, n: number): Promise<void> {
  await page.evaluate((k) => window.__earth!.renderFrames(k), n)
}

export function meanRgb(rgba: Float32Array): [number, number, number] {
  let r = 0
  let g = 0
  let b = 0
  const n = rgba.length / 4
  for (let i = 0; i < rgba.length; i += 4) {
    r += rgba[i]!
    g += rgba[i + 1]!
    b += rgba[i + 2]!
  }
  return [r / n, g / n, b / n]
}

export function countNonFinite(rgba: Float32Array): number {
  let n = 0
  for (const v of rgba) if (!Number.isFinite(v)) n++
  return n
}

export function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export async function hdrStats(page: Page, x: number, y: number, w: number, h: number) {
  return page.evaluate(([a, b, c, d]) => window.__earth!.hdrStats(a!, b!, c!, d!), [x, y, w, h])
}
