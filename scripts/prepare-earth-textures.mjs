#!/usr/bin/env node
/**
 * Builds public/earth/ from NASA's Blue Marble Next Generation
 * (Reto Stöckli, NASA Earth Observatory; https://visibleearth.nasa.gov/images/74092):
 *
 *   node scripts/prepare-earth-textures.mjs [source.jpg] [out-dir=public/earth]
 *
 * <source.jpg> is world.200407.3x21600x10800.jpg (July 2004, true color, no
 * shaded relief or bathymetry; 21600×10800 simple cylindrical, 500 m pixels).
 * Without it, it is downloaded.
 *
 * Outputs
 *   bluemarble.jpg  8192×4096 (≈4.9 km pixels at the equator), the largest
 *                   size every WebGL2 device can hold as one texture. Used for
 *                   the whole-Earth view, where it is smoother and sharper than
 *                   low-zoom map tiles.
 *   opensea.png     4096×2048 grayscale, simple cylindrical: 255 where the sea
 *                   is deeper than 60 m, 0 shallower than 10 m (smooth ramp),
 *                   from the AWS Terrain Tiles (Terrarium, z5 ≈ 4.9 km, ETOPO1
 *                   bathymetry). The app paints open sea from the Blue Marble
 *                   there, in place of the imagery tiles' patchy sea.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

const URL = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74092/world.200407.3x21600x10800.jpg'
const OUT_W = 8192
const OUT_H = 4096
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
const MASK_ZOOM = 5
const MASK_W = 4096
const MASK_H = 2048
const OPEN_SEA_DEPTH = [10, 60] // meters: ramp from coastal water to open sea

/** Decodes an 8-bit RGB, non-interlaced PNG (what Terrarium serves) to RGB bytes. */
function decodeRgbPng(png) {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (png[24] !== 8 || png[25] !== 2 || png[28] !== 0) throw new Error('expected 8-bit RGB, non-interlaced')
  const idat = []
  for (let o = 8; o < png.length; ) {
    const length = png.readUInt32BE(o)
    if (png.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + length))
    o += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 3
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? out[y * stride + i - 3] : 0
      const b = y > 0 ? out[(y - 1) * stride + i] : 0
      const c = i >= 3 && y > 0 ? out[(y - 1) * stride + i - 3] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + i] = v & 255
    }
  }
  return out
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function writeGrayPng(path, width, height, pixels) {
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 0 // grayscale
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

/** Sea depth (m, Terrarium z5) as one Web Mercator grid, 256·2^z on a side. */
async function fetchElevation() {
  const n = 2 ** MASK_ZOOM
  const size = n * 256
  const heights = new Float32Array(size * size)
  const jobs = []
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) jobs.push([x, y])
  let done = 0
  const worker = async () => {
    for (let job; (job = jobs.pop()); ) {
      const [x, y] = job
      const response = await fetch(`${TERRARIUM}/${MASK_ZOOM}/${x}/${y}.png`)
      if (!response.ok) throw new Error(`terrarium ${MASK_ZOOM}/${x}/${y}: ${response.status}`)
      const rgb = decodeRgbPng(Buffer.from(await response.arrayBuffer()))
      for (let py = 0; py < 256; py++) {
        for (let px = 0; px < 256; px++) {
          const i = (py * 256 + px) * 3
          heights[(y * 256 + py) * size + x * 256 + px] = rgb[i] * 256 + rgb[i + 1] + rgb[i + 2] / 256 - 32768
        }
      }
      if (++done % 128 === 0) console.log(`  terrarium ${done}/${n * n}`)
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker))
  return { heights, size }
}

/**
 * Mercator heights → simple cylindrical open-sea weights (bilinear). Past the
 * Mercator limit (±85.05°) the north repeats the edge (Arctic Ocean) and the
 * south is land (Antarctica).
 */
function openSeaMask({ heights, size }) {
  const mask = new Uint8Array(MASK_W * MASK_H)
  const sample = (fx, fy) => {
    const x0 = Math.floor(fx)
    const y0 = Math.min(size - 2, Math.max(0, Math.floor(fy)))
    const tx = fx - x0
    const ty = Math.min(1, Math.max(0, fy - y0))
    const at = (x, y) => heights[y * size + (((x % size) + size) % size)]
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
  }
  for (let j = 0; j < MASK_H; j++) {
    const lat = (90 - ((j + 0.5) / MASK_H) * 180) * (Math.PI / 180)
    const mercator = Math.min(Math.PI, Math.max(-Math.PI, Math.asinh(Math.tan(lat))))
    const fy = ((1 - mercator / Math.PI) / 2) * size - 0.5
    if (mercator <= -Math.PI) continue // Antarctica: stays 0
    for (let i = 0; i < MASK_W; i++) {
      const fx = ((i + 0.5) / MASK_W) * size - 0.5
      const depth = -sample(fx, fy)
      const t = Math.min(1, Math.max(0, (depth - OPEN_SEA_DEPTH[0]) / (OPEN_SEA_DEPTH[1] - OPEN_SEA_DEPTH[0])))
      mask[j * MASK_W + i] = Math.round(255 * t * t * (3 - 2 * t))
    }
  }
  return mask
}

const [given, out = 'public/earth'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'earth-textures-'))
try {
  let source = given
  if (!source) {
    source = join(work, 'world.jpg')
    console.log(`downloading ${URL}`)
    const response = await fetch(URL)
    if (!response.ok) throw new Error(`download failed: ${response.status}`)
    writeFileSync(source, Buffer.from(await response.arrayBuffer()))
  }
  const target = join(out, 'bluemarble.jpg')
  // macOS `sips`: resample (Lanczos) and re-encode.
  execFileSync('sips', ['-z', String(OUT_H), String(OUT_W), '-s', 'format', 'jpeg', '-s', 'formatOptions', '88', source, '--out', target], {
    stdio: 'ignore',
  })
  console.log(`${target}: ${OUT_W}×${OUT_H}, ${(statSync(target).size / 1e6).toFixed(1)} MB`)

  console.log(`open-sea mask from Terrarium z${MASK_ZOOM}`)
  const maskPath = join(out, 'opensea.png')
  writeGrayPng(maskPath, MASK_W, MASK_H, openSeaMask(await fetchElevation()))
  console.log(`${maskPath}: ${MASK_W}×${MASK_H}, ${(statSync(maskPath).size / 1e3).toFixed(0)} kB`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
