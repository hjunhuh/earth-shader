#!/usr/bin/env node
/**
 * Builds public/moon/ from NASA's CGI Moon Kit (https://svs.gsfc.nasa.gov/4720):
 *
 *   node scripts/prepare-moon-textures.mjs <source-dir> [out-dir=public/moon]
 *
 * <source-dir> must contain
 *   lroc_color_poles_4k.tif  LRO WAC color mosaic, 4096×2048, simple cylindrical, centered on 0°
 *   ldem_16_uint.tif         LOLA elevation, 5760×2880 (16 px/°), uint16 half-meters + 20000
 *
 * Outputs
 *   color.jpg   the color mosaic as JPEG (converted with macOS `sips`)
 *   slope_east.jpg, slope_north.jpg
 *               4096×2048 grayscale: east and north components of the LOLA
 *               terrain normal in the local (east, north, up) frame, with a
 *               signed square-root encoding e = ½ + ½·sign(n)·√|n| that keeps
 *               the gentle slopes precise (decodeSlope in MoonEffect.ts).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const MOON_RADIUS = 1737400
const OUT_W = 4096
const OUT_H = 2048

const [source, out = 'public/moon'] = process.argv.slice(2)
if (!source) {
  console.error('usage: prepare-moon-textures.mjs <source-dir> [out-dir]')
  process.exit(1)
}
mkdirSync(out, { recursive: true })

// --- color -------------------------------------------------------------------
execFileSync('sips', [
  '-s', 'format', 'jpeg',
  '-s', 'formatOptions', '90',
  join(source, 'lroc_color_poles_4k.tif'),
  '--out', join(out, 'color.jpg'),
])

// --- elevation → slopes ------------------------------------------------------
function readUncompressedTiff16(path) {
  const b = readFileSync(path)
  const le = b.toString('ascii', 0, 2) === 'II'
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
  const ifd = u32(4)
  const tags = {}
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const e = ifd + 2 + i * 12
    const type = u16(e + 2)
    const count = u32(e + 4)
    const size = type === 3 ? 2 : type === 4 ? 4 : 1
    const at = count * size > 4 ? u32(e + 8) : e + 8
    const read = (k) => (type === 3 ? u16(at + k * 2) : type === 4 ? u32(at + k * 4) : b[at + k])
    tags[u16(e)] = { count, read }
  }
  const width = tags[256].read(0)
  const height = tags[257].read(0)
  if (tags[258].read(0) !== 16 || tags[259].read(0) !== 1) throw new Error('expected uncompressed 16-bit TIFF')
  const data = new Float32Array(width * height)
  let pixel = 0
  for (let s = 0; s < tags[273].count; s++) {
    const offset = tags[273].read(s)
    const bytes = tags[279].read(s)
    for (let k = 0; k < bytes; k += 2) data[pixel++] = u16(offset + k)
  }
  return { width, height, data }
}

/** Area-weighted resample along one axis. */
function resampleAxis(src, w, h, outLen, horizontal) {
  const inLen = horizontal ? w : h
  const dst = new Float32Array(horizontal ? outLen * h : w * outLen)
  const ratio = inLen / outLen
  for (let o = 0; o < outLen; o++) {
    const x0 = o * ratio
    const x1 = x0 + ratio
    const i0 = Math.floor(x0)
    const i1 = Math.min(inLen - 1, Math.ceil(x1) - 1)
    const lines = horizontal ? h : w
    for (let line = 0; line < lines; line++) {
      let sum = 0
      for (let i = i0; i <= i1; i++) {
        const weight = Math.min(x1, i + 1) - Math.max(x0, i)
        sum += weight * src[horizontal ? line * w + i : i * w + line]
      }
      dst[horizontal ? line * outLen + o : o * w + line] = sum / ratio
    }
  }
  return dst
}

const dem = readUncompressedTiff16(join(source, 'ldem_16_uint.tif'))
for (let i = 0; i < dem.data.length; i++) dem.data[i] = (dem.data[i] - 20000) * 0.5 // meters
const rows = resampleAxis(dem.data, dem.width, dem.height, OUT_W, true)
const heights = resampleAxis(rows, OUT_W, dem.height, OUT_H, false)

const encode = (v) => Math.round(255 * (0.5 + 0.5 * Math.sign(v) * Math.sqrt(Math.min(1, Math.abs(v)))))
const dLon = (2 * Math.PI) / OUT_W
const dLat = Math.PI / OUT_H
const east = new Uint8Array(OUT_W * OUT_H)
const north = new Uint8Array(OUT_W * OUT_H)
for (let j = 0; j < OUT_H; j++) {
  const lat = Math.PI / 2 - (j + 0.5) * dLat
  const cosLat = Math.max(Math.cos(lat), Math.sin(dLat / 2))
  const up = Math.max(0, j - 1)
  const down = Math.min(OUT_H - 1, j + 1)
  for (let i = 0; i < OUT_W; i++) {
    const e = (i + 1) % OUT_W
    const w = (i - 1 + OUT_W) % OUT_W
    const dhdx = (heights[j * OUT_W + e] - heights[j * OUT_W + w]) / (2 * dLon * MOON_RADIUS * cosLat)
    const dhdy = (heights[up * OUT_W + i] - heights[down * OUT_W + i]) / ((down - up) * dLat * MOON_RADIUS)
    const len = Math.hypot(dhdx, dhdy, 1)
    east[j * OUT_W + i] = encode(-dhdx / len)
    north[j * OUT_W + i] = encode(-dhdy / len)
  }
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
/** 8-bit grayscale PNG (intermediate for sips). */
function writeGrayPng(path, pixels) {
  const raw = Buffer.alloc((OUT_W + 1) * OUT_H)
  for (let j = 0; j < OUT_H; j++) raw.set(pixels.subarray(j * OUT_W, (j + 1) * OUT_W), j * (OUT_W + 1) + 1)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(OUT_W, 0)
  ihdr.writeUInt32BE(OUT_H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}
// Grayscale JPEGs: no chroma subsampling, so each slope keeps full resolution.
const tmp = mkdtempSync(join(tmpdir(), 'moon-'))
for (const [name, pixels] of [['slope_east', east], ['slope_north', north]]) {
  const png = join(tmp, `${name}.png`)
  writeGrayPng(png, pixels)
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', png, '--out', join(out, `${name}.jpg`)])
}
rmSync(tmp, { recursive: true })
console.log(`wrote color.jpg, slope_east.jpg, slope_north.jpg to ${out}`)
