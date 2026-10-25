import { expect, test, type Page } from '@playwright/test'
import { Geodetic, radians } from '@takram/three-geospatial'
import { APP, camera, open, renderFrames } from './helpers'
import { routeTiles } from './tiles'

// lil-gui 0.21: folder = div.lil-gui > button.lil-title + div.lil-children > div.lil-controller > div.lil-name
const controller = (page: Page, folder: string, name: string) =>
  page
    .locator('.lil-gui', { has: page.locator(':scope > .lil-title', { hasText: new RegExp(`^${folder}$`) }) })
    .locator('.lil-controller', { has: page.locator('.lil-name', { hasText: new RegExp(`^${name}$`) }) })

async function setNumber(page: Page, folder: string, name: string, value: number) {
  const input = controller(page, folder, name).locator('input').first()
  await input.fill(String(value))
  await input.press('Enter')
}

const numberValue = async (page: Page, folder: string, name: string) =>
  Number(await controller(page, folder, name).locator('input').first().inputValue())

test.describe('control panel', () => {
  test('has the required controls', async ({ page }) => {
    await open(page, APP, {}, { frames: 1, ui: true })
    for (const [folder, names] of [
      ['location', ['longitude', 'latitude', 'altitude']],
      ['date', ['timeOfDay', 'dayOfYear']],
      ['cloud', ['enabled', 'quality', 'coverage', 'animate']],
    ] as const) {
      for (const name of names) await expect(controller(page, folder, name)).toHaveCount(1)
    }
    expect(await numberValue(page, 'date', 'timeOfDay')).toBe(8)
    expect(await numberValue(page, 'location', 'longitude')).toBe(30)
  })

  test('timeOfDay edits move the sun; location edits move the orbit target there', async ({ page }) => {
    await open(page, APP, {}, { frames: 1, ui: true })
    const sun0 = await page.evaluate(() => window.__earth!.sunDirection())
    await setNumber(page, 'date', 'timeOfDay', 15)
    await renderFrames(page, 1)
    expect((await page.evaluate(() => window.__earth!.getState!())).date.timeOfDay).toBe(15)
    const sun1 = await page.evaluate(() => window.__earth!.sunDirection())
    expect(Math.hypot(...sun1.map((v, i) => v - sun0[i]!))).toBeGreaterThan(0.5)

    await setNumber(page, 'location', 'longitude', 127)
    await setNumber(page, 'location', 'latitude', 37.5)
    await renderFrames(page, 1)
    const c = await camera(page)
    const want = new Geodetic(radians(127), radians(37.5), 300).toECEF()
    expect(Math.hypot(c.target[0]! - want.x, c.target[1]! - want.y, c.target[2]! - want.z)).toBeLessThan(1e-3)
  })

  test('dragging and zooming the view leaves every panel value unchanged', async ({ page }) => {
    await open(page, APP, {}, { frames: 1, ui: true })
    // Disabled inputs are live readouts (camera altitude, Moon distance), not values.
    const snapshot = () =>
      page
        .locator('.lil-gui input:not(:disabled)')
        .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).type === 'checkbox' ? String((e as HTMLInputElement).checked) : (e as HTMLInputElement).value))
    const before = await snapshot()
    await page.mouse.move(60, 250)
    await page.mouse.down()
    for (let i = 0; i < 10; ++i) {
      await page.mouse.move(60 + i * 12, 250 - i * 5)
      await renderFrames(page, 1)
    }
    await page.mouse.up()
    for (let i = 0; i < 10; ++i) {
      await page.mouse.wheel(0, 100)
      await renderFrames(page, 1)
    }
    await renderFrames(page, 60)
    expect(await snapshot()).toEqual(before)
  })
})

test.describe('normal mode (no test hooks)', () => {
  test('boots, animates with the real clock, shows the panel and the sun; no errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    await page.setViewportSize({ width: 960, height: 540 })
    // The story view (orbit controls near the ground, no terrain), where the sky and the sun are in frame.
    await page.goto('/?nav=orbit&terrain=0')
    await expect(controller(page, 'date', 'timeOfDay')).toHaveCount(1)
    expect(await page.evaluate(() => window.__earth)).toBeUndefined()
    // Wait for the LUTs and textures, then check a lit frame via a screenshot.
    await page.waitForTimeout(6000)
    const shot = await page.locator('canvas').screenshot({ path: test.info().outputPath('normal-mode.png') })
    const stats = await page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }))
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      let sum = 0
      let saturated = 0
      for (let i = 0; i < d.length; i += 4) {
        sum += d[i]! + d[i + 1]! + d[i + 2]!
        if (d[i]! > 250 && d[i + 1]! > 250 && d[i + 2]! > 250) saturated++
      }
      return { mean: sum / (d.length / 4) / 3, saturated }
    }, shot.toString('base64'))
    expect(stats.mean).toBeGreaterThan(60) // lit sky and ocean
    expect(stats.saturated).toBeGreaterThanOrEqual(3) // the sun disk: 0.53° ≈ 4 px across at 540 px / 75°
    expect(errors).toEqual([])
  })

  test('boots into the globe view: the Earth in the middle of the frame, space around it', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    const requests = await routeTiles(page)
    await page.setViewportSize({ width: 960, height: 540 })
    await page.goto('/')
    await expect(controller(page, 'terrain', 'enabled')).toHaveCount(1)
    await expect(page.locator('#attribution')).toBeVisible()
    await page.waitForTimeout(6000)
    const shot = await page.locator('canvas').screenshot()
    const regions = await page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }))
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const mean = (x: number, y: number, w: number, h: number) => {
        const d = ctx.getImageData(x, y, w, h).data
        let sum = 0
        for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!
        return sum / (d.length / 4) / 3
      }
      const s = bmp.width / 960 // device pixels
      return { center: mean(440 * s, 230 * s, 80 * s, 80 * s), corner: mean(0, 0, 80 * s, 80 * s) }
    }, shot.toString('base64'))
    expect(regions.center, 'the lit globe under the camera').toBeGreaterThan(30)
    expect(regions.corner, 'space').toBeLessThan(10)
    expect(requests.imagery + requests.elevation).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })
})
