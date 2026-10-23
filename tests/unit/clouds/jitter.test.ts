import { describe, expect, it } from 'vitest'
import { bayerCell, bayerValue, frameSampleOffset, halton } from '../../../src/clouds/jitter'

describe('temporal sample offsets', () => {
  for (const k of [2, 4] as const) {
    it(`k = ${k}: k² consecutive frames visit every cell of the block exactly once`, () => {
      for (let start = 0; start < 40; start += 7) {
        const seen = new Set<string>()
        for (let f = start; f < start + k * k; ++f) {
          const [x, y] = frameSampleOffset(f, k)
          expect(x % 1).toBe(0.5)
          seen.add(`${x},${y}`)
        }
        expect(seen.size).toBe(k * k)
      }
    })

    it(`k = ${k}: bayerCell inverts bayerValue`, () => {
      for (let i = 0; i < k * k; ++i) {
        const [x, y] = bayerCell(k, i)
        expect(bayerValue(k, x, y)).toBe(i)
      }
    })
  }

  it('Bayer order spreads consecutive samples apart (no adjacent cells in a row for k = 4)', () => {
    for (let i = 0; i < 16; ++i) {
      const [x0, y0] = bayerCell(4, i)
      const [x1, y1] = bayerCell(4, i + 1)
      expect(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))).toBeGreaterThanOrEqual(1)
      expect(x0 === x1 && y0 === y1).toBe(false)
    }
  })

  it('k = 1 uses Halton(2,3) sub-pixel jitter with a low-discrepancy mean ≈ 0.5', () => {
    expect(halton(1, 2)).toBe(0.5)
    expect(halton(2, 3)).toBeCloseTo(2 / 3, 12)
    let sx = 0
    let sy = 0
    for (let f = 0; f < 16; ++f) {
      const [x, y] = frameSampleOffset(f, 1)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
      sx += x
      sy += y
    }
    expect(sx / 16).toBeCloseTo(0.5, 1)
    expect(sy / 16).toBeCloseTo(0.5, 1)
  })
})
