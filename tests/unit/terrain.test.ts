import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { liftAboveGround } from '../../src/scene/Terrain'

describe('liftAboveGround', () => {
  it('raises a camera below the clearance along up', () => {
    const p = new Vector3(0, 0, 6_400_000)
    expect(liftAboveGround(p, new Vector3(0, 0, 1), 1000, 1200, 30)).toBe(true)
    expect(p.z).toBe(6_400_230)
  })

  it('leaves a camera with enough clearance', () => {
    const p = new Vector3(0, 0, 6_400_000)
    expect(liftAboveGround(p, new Vector3(0, 0, 1), 1000, 900, 30)).toBe(false)
    expect(liftAboveGround(p, new Vector3(0, 0, 1), 1000, Number.NaN, 30)).toBe(false)
    expect(p.z).toBe(6_400_000)
  })
})
