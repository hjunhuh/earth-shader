import { pickAt } from '../camera/controlsMath'
import { luma } from '../atmosphere/AtmosphereCpu'
import { SkyProbe, type SkyProbeQuery } from '../atmosphere/SkyProbe'
import { geodeticNormal } from '../geo/wgs84'
import { sunDirectionEcef } from '../time/solar'
import { pixelsToNdc } from '../camera/pose'
import { ecefToGeodetic } from '../geo/wgs84'
import { getTimeOfDay, type AppState } from './state'
import type { EarthApp } from './EarthApp'

/**
 * window.__earth: deterministic stepping and HDR readback for measured
 * (Playwright) tests. Installed only in test mode (?test=1).
 * Pixel coordinates are drawing-buffer pixels with a top-left origin.
 */
export interface EarthTestApi {
  ready: boolean
  errors: string[]
  size(): { width: number; height: number }
  renderFrames(n: number): void
  readHdr(x: number, y: number, w: number, h: number): number[]
  /** In-page reduction of an HDR rect (avoids shipping frames over the wire). */
  hdrStats(x: number, y: number, w: number, h: number): HdrStats
  readDistance(x: number, y: number, w: number, h: number): number[]
  /** Background-only HDR (ocean + sky, no clouds). */
  readBackground(x: number, y: number, w: number, h: number): number[]
  /** Cloud buffer RGBA (premultiplied luminance, alpha) at cloud resolution. */
  readClouds(x: number, y: number, w: number, h: number): number[]
  cloudSize(): { width: number; height: number }
  pick(px: number, py: number): { lon: number; lat: number } | null
  getState(): AppState & { timeOfDay: number }
  setCamera(camera: Partial<AppState['camera']>): void
  setTimeOfDay(tod: number): void
  setCloud(cloud: Partial<AppState['cloud']>): void
  setDebug(debug: Partial<AppState['debug']>): void
  stats(): Record<string, { p50: number; p95: number; count: number }>
  resetStats(): void
  /** Horizontal illuminance [lux] (RGB and Y) for sun elevation sin and altitude [m]. */
  illuminance(sinElevation: number, altitude?: number): { rgb: number[]; y: number; sunY: number; skyY: number }
  /** Direct-beam sun illuminance RGB [lux] (normal incidence). */
  directSun(sinElevation: number, altitude?: number): number[]
  /** Sky luminance [cd/m²] for arbitrary geometry (same GLSL as rendering). */
  probeSky(queries: SkyProbeQuery[]): number[][]
  /** Sun elevation [deg] at the ocean point under a pixel, or null if sky. */
  sunElevationAt(px: number, py: number): number | null
  /** EV100 from the CPU incident-light curve. */
  incidentEv(): number
  /** Pushes the current state into the UI panel (normally throttled in the rAF loop). */
  syncUi(): void
}

export interface HdrStats {
  nonFinite: number
  mean: [number, number, number]
  max: [number, number, number]
  count: number
}

export function computeHdrStats(rgba: Float32Array): HdrStats {
  let nonFinite = 0
  const sum = [0, 0, 0]
  const max = [-Infinity, -Infinity, -Infinity]
  let count = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const px = [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]
    if (!px.every(Number.isFinite) || !Number.isFinite(rgba[i + 3]!)) {
      nonFinite++
      continue
    }
    for (let c = 0; c < 3; ++c) {
      sum[c]! += px[c]!
      max[c] = Math.max(max[c]!, px[c]!)
    }
    count++
  }
  const n = Math.max(1, count)
  return { nonFinite, mean: [sum[0]! / n, sum[1]! / n, sum[2]! / n], max: max as [number, number, number], count }
}

declare global {
  interface Window {
    __earth?: EarthTestApi
  }
}

export function installTestHooks(app: EarthApp, frames: number, errors: string[]): EarthTestApi {
  const probe = new SkyProbe(app.renderer, app.atmosphere)
  const api: EarthTestApi = {
    ready: false,
    errors,
    size: () => ({ width: app.pipeline.width, height: app.pipeline.height }),
    renderFrames: (n) => {
      for (let i = 0; i < n; ++i) app.renderFrame(1 / 60)
    },
    readHdr: (x, y, w, h) => Array.from(app.readTexture('hdr', x, y, w, h)),
    hdrStats: (x, y, w, h) => computeHdrStats(app.readTexture('hdr', x, y, w, h)),
    readBackground: (x, y, w, h) => Array.from(app.readTexture('background', x, y, w, h)),
    readClouds: (x, y, w, h) => Array.from(app.readTexture('clouds', x, y, w, h)),
    cloudSize: () => ({ width: app.pipeline.cloudFullWidth, height: app.pipeline.cloudFullHeight }),
    readDistance: (x, y, w, h) => {
      const raw = app.readTexture('distance', x, y, w, h)
      const out: number[] = []
      for (let i = 0; i < raw.length; i += 4) out.push(raw[i]!)
      return out
    },
    pick: (px, py) => {
      const vp = app.viewport
      const { x, y } = pixelsToNdc(vp, px + 0.5, py + 0.5)
      const hit = pickAt(app.pose, vp, x, y)
      if (!hit) return null
      const g = ecefToGeodetic(hit)!
      return { lon: (g.lon * 180) / Math.PI, lat: (g.lat * 180) / Math.PI }
    },
    getState: () => ({ ...app.state, timeOfDay: getTimeOfDay(app.state) }),
    setCamera: (camera) => app.setCameraState({ ...app.state.camera, ...camera }),
    setTimeOfDay: (tod) => app.setTimeOfDay(tod),
    setCloud: (cloud) => {
      app.state = { ...app.state, cloud: { ...app.state.cloud, ...cloud } }
    },
    setDebug: (debug) => {
      app.state = { ...app.state, debug: { ...app.state.debug, ...debug } }
      if (debug.weather) app.pipeline.setWeather(debug.weather)
    },
    stats: () => app.pipeline.timer.stats(),
    resetStats: () => app.pipeline.timer.reset(),
    illuminance: (sinElevation, altitude = 0) => {
      const r = app.atmosphere.cpu!.horizontalIlluminance(sinElevation, altitude / 1000)
      return { rgb: [...r.total], y: luma(r.total), sunY: luma(r.sun), skyY: luma(r.sky) }
    },
    directSun: (sinElevation, altitude = 0) => [...app.atmosphere.cpu!.directSun(sinElevation, altitude / 1000)],
    probeSky: (queries) => probe.evaluate(queries).map((v) => [...v]),
    sunElevationAt: (px, py) => {
      const vp = app.viewport
      const { x, y } = pixelsToNdc(vp, px + 0.5, py + 0.5)
      const hit = pickAt(app.pose, vp, x, y)
      if (!hit) return null
      const g = ecefToGeodetic(hit)!
      const n = geodeticNormal(g.lon, g.lat)
      const sun = sunDirectionEcef(app.state.utcMs)
      return (Math.asin(Math.max(-1, Math.min(1, n.dot(sun)))) * 180) / Math.PI
    },
    incidentEv: () => app.ev100,
    syncUi: () => app.ui?.sync(app.state, app.ev100),
  }
  window.__earth = api
  // Converge temporal effects before signalling readiness.
  api.renderFrames(frames)
  api.ready = true
  return api
}
