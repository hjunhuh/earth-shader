import { expect, test, type Page } from '@playwright/test'
import { Geodetic } from '@takram/three-geospatial'
import { Quaternion, Vector3 } from 'three'
import { APP, diff, open, readPixels, renderFrames } from './helpers'
import { routeTiles } from './tiles'

/**
 * The default Earth controls (Google Earth style): the app starts looking
 * straight down at the location with the globe in the middle; a left drag
 * turns the globe under the cursor, the wheel zooms, a right drag tilts.
 * Terrain off, so no tiles are fetched; the controls then work on the WGS84
 * ellipsoid.
 */
const LOCATION = { lon: 30, lat: 35 }
const CENTER: [number, number] = [320, 180]

async function openGlobe(page: Page, params: Record<string, string | number> = {}): Promise<void> {
  await open(page, APP, { nav: 'globe', ...LOCATION, ...params }, { frames: 4 })
  expect(await page.evaluate(() => window.__earth!.earthControls!())).toBe('globe')
}

interface View {
  /** Geodetic height of the camera (m). */
  altitude: number
  /** Angle between the view direction and straight down (degrees). */
  tilt: number
  /** Geodetic point under the screen center (degrees). */
  center: [number, number] | null
}

async function view(page: Page): Promise<View> {
  const c = await page.evaluate(() => window.__earth!.camera())
  const position = new Vector3(...(c.position as [number, number, number]))
  const forward = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...(c.quaternion as [number, number, number, number])))
  // The geodetic normal (straight down at any height), not the gradient at the camera.
  const g = new Geodetic().setFromECEF(position)
  const up = new Vector3(Math.cos(g.latitude) * Math.cos(g.longitude), Math.cos(g.latitude) * Math.sin(g.longitude), Math.sin(g.latitude))
  const center = await page.evaluate(([x, y]) => window.__earth!.surfacePointAt!(x!, y!), CENTER)
  return {
    altitude: g.height,
    tilt: (Math.acos(Math.min(1, -forward.dot(up))) * 180) / Math.PI,
    center,
  }
}

const pointAt = (page: Page, p: [number, number]) => page.evaluate(([x, y]) => window.__earth!.surfacePointAt!(x!, y!), p)

async function drag(page: Page, from: [number, number], to: [number, number], button: 'left' | 'right' = 'left') {
  await page.mouse.move(...from)
  await page.mouse.down({ button })
  for (let i = 1; i <= 12; ++i) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 12, from[1] + ((to[1] - from[1]) * i) / 12)
    await renderFrames(page, 1)
  }
  await page.mouse.up({ button })
  await renderFrames(page, 2)
}

async function wheel(page: Page, at: [number, number], deltaY: number, times: number) {
  await page.mouse.move(...at)
  for (let i = 0; i < times; ++i) {
    await page.mouse.wheel(0, deltaY)
    await renderFrames(page, 1)
  }
  await renderFrames(page, 2)
}

/** Great-circle distance in degrees. */
function separation(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180
  const cos =
    Math.sin(a[1] * r) * Math.sin(b[1] * r) + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.cos((a[0] - b[0]) * r)
  return Math.acos(Math.min(1, cos)) / r
}

test.describe('globe controls', () => {
  test('start straight down over the location, the globe in the middle', async ({ page }) => {
    await openGlobe(page)
    const v = await view(page)
    expect(v.tilt).toBeLessThan(0.01)
    expect(v.altitude).toBeCloseTo(1e7, -3)
    expect(separation(v.center!, [LOCATION.lon, LOCATION.lat])).toBeLessThan(0.01)
    // The whole disk is in view: the screen edges look past the Earth.
    expect(await pointAt(page, [5, 180])).toBeNull()
    expect(await pointAt(page, [635, 180])).toBeNull()
  })

  test('a left drag turns the globe so the grabbed point follows the cursor', async ({ page }) => {
    await openGlobe(page)
    const from: [number, number] = [300, 170]
    const to: [number, number] = [380, 210]
    const grabbed = (await pointAt(page, from))!
    const before = await view(page)
    await drag(page, from, to)
    const after = await view(page)
    expect(separation(after.center!, before.center!), 'the globe turned').toBeGreaterThan(3)
    expect(separation((await pointAt(page, to))!, grabbed), 'grabbed point under the cursor').toBeLessThan(1)
    expect(Math.abs(after.altitude / before.altitude - 1)).toBeLessThan(0.05)
  })

  test('the wheel zooms in and out', async ({ page }) => {
    await openGlobe(page)
    const start = (await view(page)).altitude
    await wheel(page, CENTER, -300, 12)
    const zoomedIn = await view(page)
    expect(zoomedIn.altitude).toBeLessThan(0.5 * start)
    expect(separation(zoomedIn.center!, [LOCATION.lon, LOCATION.lat]), 'zoomed toward the cursor').toBeLessThan(0.5)
    await wheel(page, CENTER, 300, 6)
    expect((await view(page)).altitude).toBeGreaterThan(1.5 * zoomedIn.altitude)
  })

  test('a right drag tilts the view toward the horizon near the ground', async ({ page }) => {
    await openGlobe(page)
    await wheel(page, CENTER, -300, 34)
    const low = await view(page)
    expect(low.altitude).toBeLessThan(100_000)
    expect(low.tilt).toBeLessThan(1)
    await drag(page, [320, 300], [320, 150], 'right')
    const tilted = await view(page)
    expect(tilted.tilt).toBeGreaterThan(20)
    expect(tilted.altitude).toBeGreaterThan(0)
  })

  test('a new location looks straight down at it from the same height', async ({ page }) => {
    await openGlobe(page)
    await wheel(page, CENTER, -300, 8)
    const before = await view(page)
    await page.evaluate(() => window.__earth!.setState!({ location: { longitude: 127, latitude: 37.5 } }))
    await renderFrames(page, 2)
    const after = await view(page)
    expect(separation(after.center!, [127, 37.5])).toBeLessThan(0.01)
    expect(after.tilt).toBeLessThan(0.01)
    expect(after.altitude / before.altitude).toBeCloseTo(1, 2)
  })

  test('after a round trip to the Moon the globe view and its controls come back', async ({ page }) => {
    await openGlobe(page)
    await page.evaluate(() => window.__earth!.flyTo!('moon', { instant: true }))
    await renderFrames(page, 2)
    expect(await page.evaluate(() => window.__earth!.focus!())).toBe('moon')
    await page.evaluate(() => window.__earth!.flyTo!('earth', { instant: true }))
    await renderFrames(page, 2)
    expect(await page.evaluate(() => window.__earth!.focus!())).toBe('earth')
    const back = await view(page)
    expect(back.tilt).toBeLessThan(0.01)
    expect(separation(back.center!, [LOCATION.lon, LOCATION.lat])).toBeLessThan(0.01)
    await drag(page, [300, 170], [380, 210])
    expect(separation((await view(page)).center!, back.center!), 'drag still turns the globe').toBeGreaterThan(3)
  })

  test('the compass button turns north up around the screen center', async ({ page }) => {
    await openGlobe(page)
    await wheel(page, CENTER, -300, 30)
    // Tilt, then turn the view with a sideways right drag.
    await drag(page, [320, 300], [320, 220], 'right')
    await drag(page, [200, 250], [420, 250], 'right')
    const heading = await page.evaluate(() => window.__earth!.heading!())
    expect(Math.abs(heading), 'the view was turned').toBeGreaterThan(20)
    const needle = () => page.locator('#compass .needle').evaluate((e) => getComputedStyle(e).transform)
    const angle = (matrix: string) => {
      const [a, b] = matrix.slice(7, -1).split(',').map(Number)
      return (Math.atan2(b!, a!) * 180) / Math.PI
    }
    expect(angle(await needle()), 'the needle points north on screen').toBeCloseTo(-heading, 0)
    const before = await view(page)
    expect(before.tilt).toBeGreaterThan(10)

    await page.click('#compass')
    await renderFrames(page, 60) // 0.8 s at 60 Hz
    const after = await view(page)
    expect(Math.abs(await page.evaluate(() => window.__earth!.heading!()))).toBeLessThan(0.1)
    expect(Math.abs(angle(await needle()))).toBeLessThan(0.2)
    expect(separation(after.center!, before.center!), 'same point at the center').toBeLessThan(0.001)
    expect(after.tilt).toBeCloseTo(before.tilt, 1)
    expect(after.altitude / before.altitude).toBeCloseTo(1, 3)
  })

  test('on the Moon the compass turns lunar north up', async ({ page }) => {
    await openGlobe(page)
    await page.evaluate(() => window.__earth!.flyTo!('moon', { instant: true, heading: 60, tilt: 30 }))
    await renderFrames(page, 2)
    expect(await page.evaluate(() => window.__earth!.heading!())).toBeCloseTo(60, 3)
    await page.click('#compass')
    await renderFrames(page, 2)
    expect(await page.evaluate(() => window.__earth!.heading!())).toBeCloseTo(0, 3)
    expect((await page.evaluate(() => window.__earth!.moonView!())).tilt).toBeCloseTo((30 * Math.PI) / 180, 3)
  })

  test('from afar the globe shows the Blue Marble, up close the imagery tiles', async ({ browser }) => {
    // Tiles in two loud land colors: whatever differs between the frames came from the tiles.
    const frame = async (land: number[], zoomIn: boolean) => {
      const page = await browser.newPage()
      try {
        await routeTiles(page, { land })
        await openGlobe(page, { terrain: 1, clouds: 0, tod: 12, doy: 170 })
        if (zoomIn) await wheel(page, CENTER, -300, 30)
        for (let i = 0; i < 100; ++i) {
          await renderFrames(page, 4)
          if ((await page.evaluate(() => window.__earth!.terrainProgress!())) >= 1 && i >= 8) break
          await page.waitForTimeout(50)
        }
        await renderFrames(page, 30)
        return await readPixels(page, 220, 100, 200, 160)
      } finally {
        await page.close()
      }
    }
    const magenta = [0xff, 0x00, 0xff]
    const green = [0x00, 0xc0, 0x00]
    const far = diff(await frame(magenta, false), await frame(green, false), 2)
    expect(far.mean, 'the globe ignores the tile colors from afar').toBeLessThan(0.5)
    const near = diff(await frame(magenta, true), await frame(green, true), 2)
    expect(near.mean, 'close up the tiles show').toBeGreaterThan(20)
  })
})
