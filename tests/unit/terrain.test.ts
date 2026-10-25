import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { liftAboveGround } from '../../src/scene/Terrain'
import { OSM_WATER_LINEAR, OSM_WATER_SRGB, srgbToLinear, waterWeight } from '../../src/scene/terrainMath'

const linear = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((c) => srgbToLinear(c / 255)) as [number, number, number]

describe('OSM water detection', () => {
  it('matches the OSM Carto water fill exactly', () => {
    expect(OSM_WATER_SRGB.map((c) => Math.round(c * 255))).toEqual([0xaa, 0xd3, 0xdf])
    expect(waterWeight(OSM_WATER_LINEAR)).toBe(1)
    expect(waterWeight(linear(0xaad3df))).toBeCloseTo(1, 6)
  })

  it('leaves land, parks, roads and buildings alone', () => {
    for (const land of [0xf2efe9, 0xc8facc, 0xadd19e, 0xf7fabf, 0xe892a2, 0xd9d0c9, 0xffffff, 0xdddde8]) {
      expect(waterWeight(linear(land)), land.toString(16)).toBe(0)
    }
  })

  it('blends across anti-aliased coastlines', () => {
    const half = OSM_WATER_LINEAR.map((w, i) => (w + linear(0xf2efe9)[i]!) / 2) as [number, number, number]
    const quarter = OSM_WATER_LINEAR.map((w, i) => w * 0.97 + linear(0xf2efe9)[i]! * 0.03) as [number, number, number]
    expect(waterWeight(half)).toBe(0)
    expect(waterWeight(quarter)).toBeGreaterThan(0.5)
  })
})

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
