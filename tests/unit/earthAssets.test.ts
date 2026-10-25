import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

/** public/earth/, as built by scripts/prepare-earth-textures.mjs. */
const dir = new URL('../../public/earth/', import.meta.url)

/** Width/height of a baseline or progressive JPEG (SOF0/SOF2 marker). */
function jpegSize(jpeg: Buffer): [number, number] {
  for (let o = 2; o < jpeg.length; ) {
    const marker = jpeg[o + 1]!
    const length = jpeg.readUInt16BE(o + 2)
    if (marker === 0xc0 || marker === 0xc2) return [jpeg.readUInt16BE(o + 7), jpeg.readUInt16BE(o + 5)]
    o += 2 + length
  }
  throw new Error('no SOF marker')
}

/** 8-bit grayscale PNG written with filter 0 on every row (what the script writes). */
function readGrayPng(png: Buffer): { width: number; height: number; at(lon: number, lat: number): number } {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  expect([png[24], png[25]]).toEqual([8, 0])
  const idat: Buffer[] = []
  for (let o = 8; o < png.length; ) {
    const length = png.readUInt32BE(o)
    if (png.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + length))
    o += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  return {
    width,
    height,
    at(lon, lat) {
      const x = Math.min(width - 1, Math.floor(((lon + 180) / 360) * width))
      const y = Math.min(height - 1, Math.floor(((90 - lat) / 180) * height))
      expect(raw[y * (width + 1)]).toBe(0)
      return raw[y * (width + 1) + 1 + x]!
    },
  }
}

describe('earth assets', () => {
  it('the Blue Marble is 8192×4096', () => {
    expect(jpegSize(readFileSync(new URL('bluemarble.jpg', dir)))).toEqual([8192, 4096])
  })

  it('the open-sea mask marks deep sea, not land, lakes or the poles’ land', () => {
    const mask = readGrayPng(readFileSync(new URL('opensea.png', dir)))
    expect([mask.width, mask.height]).toEqual([4096, 2048])
    const sea = { pacific: [-150, 0], mediterranean: [18, 35], tyrrhenian: [12, 40], arctic: [0, 88], southernOcean: [0, -60] }
    const land = { sahara: [10, 25], alps: [8, 46.5], lakeVictoria: [33, -1], southPole: [0, -89], amazon: [-60, -3] }
    for (const [name, [lon, lat]] of Object.entries(sea)) expect(mask.at(lon!, lat!), name).toBe(255)
    for (const [name, [lon, lat]] of Object.entries(land)) expect(mask.at(lon!, lat!), name).toBe(0)
  })
})
