import { afterAll, describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { CloudResources } from '../../../src/clouds/CloudResources'
import { ReadbackPass } from '../../../src/render/ReadbackPass'
import { captureShaderErrors, createTestRenderer, disposeTestRenderer } from '../harness/context'

const renderer = createTestRenderer(64, 64)
const errors = captureShaderErrors(renderer)
const readback = new ReadbackPass()
afterAll(() => {
  readback.dispose()
  disposeTestRenderer(renderer)
})

describe('sun optical depth cubemap', () => {
  it('matches the analytic slab optical depth τ·(fraction above)/cos θs within 5%', () => {
    const SIZE = 64
    const res = new CloudResources(renderer, { weatherSize: 64, sunOpticalDepthSize: SIZE })
    res.bakeStatic(1)
    const tau = 12
    res.setWeather({ kind: 'slab', tau, bottom: 1000, top: 3000 })
    // Sun 40° from the +Z axis: texels near the +Z face center see θs ≈ 40°.
    const sun = new Vector3(Math.sin((40 * Math.PI) / 180), 0, Math.cos((40 * Math.PI) / 180))
    res.updateSunOpticalDepth(sun, true)
    expect(errors.errors).toEqual([])
    const face = readback.readCubeFace(renderer, res.sunODTarget.texture, SIZE, 4) // +Z
    const i = ((SIZE / 2) * SIZE + SIZE / 2) * 4
    const mu = sun.z // normal ≈ +Z at the face center
    // Channels: heights (0, bottom, mid, top) = (0, 1000, 2000, 3000).
    const expected = [tau / mu, tau / mu, (tau / 2) / mu, 0]
    for (let c = 0; c < 4; ++c) {
      const got = face[i + c]!
      if (expected[c] === 0) expect(Math.abs(got)).toBeLessThan(0.05)
      else expect(Math.abs(got - expected[c]!) / expected[c]!, `channel ${c}: ${got} vs ${expected[c]}`).toBeLessThan(0.05)
    }
    // Sun below the local horizon: no optical depth (no direct light anyway).
    res.updateSunOpticalDepth(new Vector3(0, 0, -1), true)
    const night = readback.readCubeFace(renderer, res.sunODTarget.texture, SIZE, 4)
    expect(night[i]).toBe(0)
    res.dispose()
  })
})
