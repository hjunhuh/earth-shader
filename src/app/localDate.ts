import { DATE_YEAR } from './defaults'

/**
 * Same mapping as takram's storybook `useLocalDateControls` with a longitude:
 * local mean time at the given longitude, `dayOfYear` whole days after
 * January 1st 00:00 UTC.
 */
export function localDateMs(longitude: number, dayOfYear: number, timeOfDay: number, year = DATE_YEAR): number {
  const epoch = Date.UTC(year, 0, 1, 0, 0, 0, 0)
  const offset = longitude / 15
  return epoch + (Math.floor(dayOfYear) * 24 + timeOfDay - offset) * 3600000
}
