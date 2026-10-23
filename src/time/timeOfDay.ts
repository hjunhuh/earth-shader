import { solarCoordinates, subsolarPoint } from './solar'

/**
 * The canonical clock is an absolute UTC instant. `timeofday` is a derived
 * display value: local apparent solar time at a longitude (12.0 = the sun
 * crosses that meridian). Editing timeofday moves the UTC instant; moving
 * the camera keeps the instant (the terminator stays fixed to the Earth).
 */

/** Fixed calendar date (local solar date at the reference longitude). */
export const DEFAULT_DATE = '2026-03-20'
export const DEFAULT_TIME_OF_DAY = 8.0

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

export function wrap24(hours: number): number {
  const w = ((hours % 24) + 24) % 24
  return w === 24 ? 0 : w
}

export function parseDateUtc(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (m === null) throw new Error(`Invalid date "${date}" (expected YYYY-MM-DD)`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const ms = Date.UTC(y, mo - 1, d)
  const check = new Date(ms)
  // Date.UTC silently rolls over (month 13, day 45); reject those.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new Error(`Invalid date "${date}"`)
  }
  return ms
}

/** Local apparent solar time [h, 0..24) at a longitude for a UTC instant. */
export function timeOfDayAt(utcMs: number, lonDeg: number): number {
  const { lon } = subsolarPoint(utcMs)
  return wrap24(12 + (lonDeg - lon) / 15)
}

/**
 * UTC instant at which the local apparent solar time at `lonDeg` equals
 * `timeOfDay` on the given local solar date. Solves
 *   UTC_h = tod − lon/15 − EoT(UTC)/60
 * by fixed-point iteration (EoT varies < 1 s/min, two steps suffice).
 */
export function utcForTimeOfDay(timeOfDay: number, lonDeg: number, dateUtcMs: number): number {
  const baseHours = timeOfDay - lonDeg / 15
  let utc = dateUtcMs + baseHours * HOUR_MS
  for (let i = 0; i < 4; ++i) {
    const eot = solarCoordinates(utc).equationOfTime
    utc = dateUtcMs + (baseHours - eot / 60) * HOUR_MS
  }
  return utc
}

/**
 * Re-anchors an edit of timeofday while keeping the local solar *date* the
 * one implied by the current instant, so scrubbing 23.9 -> 0.1 wraps within
 * the same displayed day instead of jumping by a day.
 */
export function localSolarDateUtc(utcMs: number, lonDeg: number): number {
  const eot = solarCoordinates(utcMs).equationOfTime
  const local = utcMs + (lonDeg / 15 + eot / 60) * HOUR_MS
  return Math.floor(local / DAY_MS) * DAY_MS
}

/** Applies a timeofday edit at a longitude, keeping the current local solar date. */
export function setTimeOfDay(utcMs: number, lonDeg: number, timeOfDay: number): number {
  return utcForTimeOfDay(timeOfDay, lonDeg, localSolarDateUtc(utcMs, lonDeg))
}
