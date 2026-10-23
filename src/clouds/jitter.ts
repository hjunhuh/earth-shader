/**
 * Sample offsets for temporal reconstruction. With an upscale factor k the
 * low-res pass covers one full-res pixel per k×k block each frame, in Bayer
 * order, so every pixel is refreshed exactly once per k² frames. With k = 1
 * a Halton(2, 3) sub-pixel jitter drives plain TAA.
 */

const BAYER_2 = [0, 2, 3, 1]
const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** Bayer matrix value at (x, y) for size k (2 or 4). */
export function bayerValue(k: 2 | 4, x: number, y: number): number {
  return k === 2 ? BAYER_2[(y % 2) * 2 + (x % 2)]! : BAYER_4[(y % 4) * 4 + (x % 4)]!
}

/** Inverse: the (x, y) cell visited at sequence index i (cells sorted by Bayer value). */
export function bayerCell(k: 2 | 4, i: number): [number, number] {
  const n = k * k
  const target = ((i % n) + n) % n
  for (let y = 0; y < k; ++y) for (let x = 0; x < k; ++x) if (bayerValue(k, x, y) === target) return [x, y]
  throw new Error('unreachable')
}

export function halton(index: number, base: number): number {
  let f = 1
  let r = 0
  let i = index
  while (i > 0) {
    f /= base
    r += f * (i % base)
    i = Math.floor(i / base)
  }
  return r
}

/**
 * Full-res pixel offset (with the +0.5 pixel center) of this frame's sample
 * inside its k×k block: for k > 1 an integer cell + 0.5, for k = 1 a Halton
 * sub-pixel position in [0, 1).
 */
export function frameSampleOffset(frame: number, k: 1 | 2 | 4): [number, number] {
  if (k === 1) {
    const i = (frame % 16) + 1
    return [halton(i, 2), halton(i, 3)]
  }
  const [x, y] = bayerCell(k, frame)
  return [x + 0.5, y + 0.5]
}
