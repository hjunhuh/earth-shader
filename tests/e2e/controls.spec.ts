import { expect, test, type Page } from '@playwright/test'
import { APP, camera, cameraDistance, open, REF, renderFrames, type CameraState } from './helpers'

/**
 * Controls must be takram's: the same mouse input is replayed on the app and
 * on the reference page (drei <OrbitControls minDistance={1000} />), frame by
 * frame, and the resulting cameras are compared.
 */
type Step =
  | { kind: 'drag'; button: 'left' | 'right'; from: [number, number]; to: [number, number]; steps: number }
  | { kind: 'wheel'; at: [number, number]; deltaY: number; times: number }
  | { kind: 'frames'; n: number }

async function play(page: Page, steps: Step[]): Promise<void> {
  for (const s of steps) {
    if (s.kind === 'frames') {
      await renderFrames(page, s.n)
    } else if (s.kind === 'wheel') {
      await page.mouse.move(...s.at)
      for (let i = 0; i < s.times; ++i) {
        await page.mouse.wheel(0, s.deltaY)
        await renderFrames(page, 1)
      }
    } else {
      await page.mouse.move(...s.from)
      await page.mouse.down({ button: s.button })
      for (let i = 1; i <= s.steps; ++i) {
        const t = i / s.steps
        await page.mouse.move(s.from[0] + (s.to[0] - s.from[0]) * t, s.from[1] + (s.to[1] - s.from[1]) * t)
        await renderFrames(page, 1)
      }
      await page.mouse.up({ button: s.button })
    }
  }
}

const SEQUENCES: Record<string, Step[]> = {
  'left-drag orbit (with damping tail)': [
    { kind: 'drag', button: 'left', from: [320, 180], to: [420, 140], steps: 12 },
    { kind: 'frames', n: 90 },
  ],
  'right-drag pan': [
    { kind: 'drag', button: 'right', from: [320, 200], to: [250, 260], steps: 10 },
    { kind: 'frames', n: 90 },
  ],
  'wheel dolly out, then partway back in': [
    { kind: 'wheel', at: [320, 180], deltaY: 100, times: 15 },
    { kind: 'frames', n: 30 },
    { kind: 'wheel', at: [320, 180], deltaY: -100, times: 6 },
    { kind: 'frames', n: 30 },
  ],
  'wheel in against minDistance, then orbit': [
    { kind: 'wheel', at: [320, 180], deltaY: -100, times: 20 },
    { kind: 'drag', button: 'left', from: [320, 180], to: [200, 200], steps: 10 },
    { kind: 'frames', n: 60 },
  ],
  'mixed session': [
    { kind: 'drag', button: 'left', from: [300, 200], to: [200, 120], steps: 8 },
    { kind: 'wheel', at: [320, 180], deltaY: 100, times: 6 },
    { kind: 'drag', button: 'right', from: [320, 180], to: [360, 220], steps: 6 },
    { kind: 'drag', button: 'left', from: [320, 180], to: [330, 300], steps: 8 },
    { kind: 'frames', n: 120 },
  ],
}

function expectSameCamera(a: CameraState, b: CameraState): void {
  for (let i = 0; i < 3; ++i) {
    expect(Math.abs(a.position[i]! - b.position[i]!)).toBeLessThan(1e-6)
    expect(Math.abs(a.target[i]! - b.target[i]!)).toBeLessThan(1e-6)
    expect(Math.abs(a.up[i]! - b.up[i]!)).toBeLessThan(1e-12)
  }
  for (let i = 0; i < 4; ++i) expect(Math.abs(a.quaternion[i]! - b.quaternion[i]!)).toBeLessThan(1e-9)
  expect(a.near).toBe(b.near)
  expect(a.far).toBe(b.far)
  expect(a.fov).toBe(b.fov)
}

test.describe('controls match takram Clouds/Basic (drei OrbitControls)', () => {
  test('same starting camera', async ({ browser }) => {
    const app = await browser.newPage()
    const ref = await browser.newPage()
    await open(app, APP, {}, { frames: 1 })
    await open(ref, REF, {}, { frames: 1 })
    expectSameCamera(await camera(app), await camera(ref))
    expect(cameraDistance(await camera(app))).toBeCloseTo(1000, 6)
  })

  for (const [name, steps] of Object.entries(SEQUENCES)) {
    test(name, async ({ browser }) => {
      const app = await browser.newPage()
      const ref = await browser.newPage()
      await open(app, APP, {}, { frames: 1 })
      await open(ref, REF, {}, { frames: 1 })
      const before = await camera(app)
      await play(app, steps)
      await play(ref, steps)
      const a = await camera(app)
      expectSameCamera(a, await camera(ref))
      // The input really moved the camera.
      expect(Math.hypot(...a.position.map((v, i) => v - before.position[i]!))).toBeGreaterThan(10)
    })
  }
})

test.describe('orbit behavior', () => {
  test('left drag orbits around the location: target and distance fixed', async ({ page }) => {
    await open(page, APP, {}, { frames: 1 })
    const before = await camera(page)
    await play(page, SEQUENCES['left-drag orbit (with damping tail)']!)
    const after = await camera(page)
    expect(after.target).toEqual(before.target)
    expect(cameraDistance(after)).toBeCloseTo(cameraDistance(before), 3)
  })

  test('wheel changes the distance but never below minDistance = 1000 m', async ({ page }) => {
    await open(page, APP, {}, { frames: 1 })
    await play(page, [{ kind: 'wheel', at: [320, 180], deltaY: 100, times: 10 }, { kind: 'frames', n: 10 }])
    const out = cameraDistance(await camera(page))
    expect(out).toBeGreaterThan(1500)
    await play(page, [{ kind: 'wheel', at: [320, 180], deltaY: -100, times: 60 }, { kind: 'frames', n: 10 }])
    expect(cameraDistance(await camera(page))).toBeCloseTo(1000, 3)
  })

  test('right drag pans the target', async ({ page }) => {
    await open(page, APP, {}, { frames: 1 })
    const before = await camera(page)
    await play(page, SEQUENCES['right-drag pan']!)
    const after = await camera(page)
    expect(Math.hypot(...after.target.map((v, i) => v - before.target[i]!))).toBeGreaterThan(50)
  })
})

test.describe('values are fixed: mouse input never changes them', () => {
  test('location, date, cloud, exposure and the sun stay put through drags and wheel', async ({ page }) => {
    await open(page, APP, { tod: 8 }, { frames: 1 })
    const read = () =>
      page.evaluate(() => {
        const e = window.__earth!
        return { state: e.getState!(), exposure: e.exposure(), date: e.dateMs(), sun: e.sunDirection() }
      })
    const before = await read()
    for (const steps of Object.values(SEQUENCES)) await play(page, steps)
    const after = await read()
    expect(after).toEqual(before)
    expect(before.exposure).toBe(10)
    expect(before.state.date.timeOfDay).toBe(8)
  })
})
