import { expect, test, type Page } from '@playwright/test'
import { openApp, renderFrames } from './helpers'

/** Drives the real lil-gui panel (location / date / cloud) and checks two-way binding. */
const controller = (page: Page, label: string) =>
  page.locator('.lil-controller', { has: page.locator('.lil-name', { hasText: new RegExp(`^${label}`) }) })

async function setNumber(page: Page, label: string, value: number) {
  const input = controller(page, label).locator('input').last()
  await input.fill(String(value))
  await input.press('Enter')
  await renderFrames(page, 2)
}

test.describe('UI panel', () => {
  test('exposes the required controls: location{long, lat, altitude}, date{timeofday}, cloud{enabled, quality}', async ({ page }) => {
    await openApp(page, { params: { ui: 1 } })
    for (const folder of ['location', 'date', 'cloud']) await expect(page.locator('.lil-title', { hasText: folder }).first()).toBeVisible()
    for (const name of ['long', 'lat', 'altitude', 'timeofday', 'enabled', 'quality']) await expect(controller(page, name)).toHaveCount(1)
    await expect(controller(page, 'timeofday').locator('input').last()).toHaveValue('8')
  })

  test('editing the controls drives the app state', async ({ page }) => {
    await openApp(page, { params: { ui: 1 } })
    await setNumber(page, 'timeofday', 17.5)
    expect((await page.evaluate(() => window.__earth!.getState())).timeOfDay).toBeCloseTo(17.5, 2)
    await setNumber(page, 'long', 10)
    await setNumber(page, 'lat', -20)
    await setNumber(page, 'altitude', 5000)
    const cam = (await page.evaluate(() => window.__earth!.getState())).camera
    expect(cam.lon).toBeCloseTo(10, 3)
    expect(cam.lat).toBeCloseTo(-20, 3)
    expect(cam.alt).toBeCloseTo(5000, 0)
    await controller(page, 'enabled').locator('input').uncheck()
    expect((await page.evaluate(() => window.__earth!.getState())).cloud.enabled).toBe(false)
    await controller(page, 'quality').locator('select').selectOption('low')
    expect((await page.evaluate(() => window.__earth!.getState())).cloud.quality).toBe('low')
  })

  test('moving the camera updates the panel; the sun stays fixed to the Earth', async ({ page }) => {
    await openApp(page, { params: { ui: 1, lon: 0, lat: 0, alt: 2_000_000, tod: 12 } })
    await page.evaluate(() => window.__earth!.setCamera({ lon: 30 }))
    await page.evaluate(() => window.__earth!.syncUi())
    await expect(controller(page, 'long').locator('input').last()).toHaveValue('30')
    // 30° east of local noon is 14:00 local solar time.
    await expect(controller(page, 'timeofday').locator('input').last()).toHaveValue('14')
  })
})
