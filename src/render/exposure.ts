import { ev100FromIlluminance, luma, type AtmosphereCpu } from '../atmosphere/AtmosphereCpu'

/**
 * Deterministic exposure: EV100 follows the horizontal illuminance at the
 * point the camera looks at (incident-meter rule EV100 = log2(E·100/250)),
 * blended toward a fixed "sunlit Earth from space" value at high altitude,
 * where the frame is dominated by the lit disk. No histogram feedback, so
 * measured tests are reproducible.
 */
export const EV_SPACE = 14.6
export const EV_MIN = -3.0
export const EV_MAX = 15.5
/** One stop brighter than an incident meter: sunlit cloud tops read white. */
export const EV_COMPENSATION = -1

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

export function autoEv100(cpu: AtmosphereCpu, sunSinElevation: number, cameraAltitude: number): number {
  const lux = luma(cpu.horizontalIlluminance(sunSinElevation).total)
  const local = ev100FromIlluminance(lux) + EV_COMPENSATION
  const w = smoothstep(Math.log10(100_000), Math.log10(3_000_000), Math.log10(Math.max(1, cameraAltitude)))
  const ev = local * (1 - w) + EV_SPACE * w
  return Math.min(EV_MAX, Math.max(EV_MIN, ev))
}

/** Linear multiplier for buffer luminance (kcd/m²) at a given EV100. */
export function exposureFromEv100(ev100: number): number {
  return 1000 / (1.2 * 2 ** ev100)
}

/**
 * Auto-exposure clamp range by altitude. On the ground the meter is free
 * (twilight may open up to EV 1). From orbit the range narrows to a
 * daylight exposure (EV 14.3–15) like real orbital photography: the ocean
 * reads dark navy and the night side stays dark.
 */
export function autoEvRange(cameraAltitude: number): [number, number] {
  const w = smoothstep(Math.log10(100_000), Math.log10(3_000_000), Math.log10(Math.max(1, cameraAltitude)))
  // Ground floor −3 (long-exposure night photography): stars stay visible.
  return [-3 + 17.3 * w, 16 - 1 * w]
}
