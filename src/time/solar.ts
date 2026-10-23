import { Vector3 } from 'three'

/**
 * Low-precision solar ephemeris following the NOAA solar calculator
 * (Meeus, "Astronomical Algorithms"). Accuracy ≈ 0.01° for 1950–2050.
 * Times are UTC milliseconds (UT1 ≈ UTC; ΔT ignored as in NOAA).
 */

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

export function julianDay(utcMs: number): number {
  return utcMs / 86_400_000 + 2_440_587.5
}

export function julianCentury(utcMs: number): number {
  return (julianDay(utcMs) - 2_451_545) / 36_525
}

const mod = (x: number, m: number) => ((x % m) + m) % m

export interface SolarCoordinates {
  /** Declination [deg]. */
  declination: number
  /** Right ascension [deg, 0..360). */
  rightAscension: number
  /** Equation of time [minutes] (apparent − mean solar time). */
  equationOfTime: number
  /** Apparent ecliptic longitude [deg]. */
  apparentLongitude: number
  /** Earth–Sun distance [AU]. */
  distance: number
}

export function solarCoordinates(utcMs: number): SolarCoordinates {
  const T = julianCentury(utcMs)
  const L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360)
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
  const Mr = M * RAD
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289
  const trueLong = L0 + C
  const trueAnomaly = M + C
  const distance = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(trueAnomaly * RAD))
  const omega = 125.04 - 1934.136 * T
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD)
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD)
  const lr = lambda * RAD
  const er = eps * RAD
  const declination = Math.asin(Math.sin(er) * Math.sin(lr)) * DEG
  const rightAscension = mod(Math.atan2(Math.cos(er) * Math.sin(lr), Math.cos(lr)) * DEG, 360)
  const y = Math.tan(er / 2) ** 2
  const L0r = L0 * RAD
  const eot =
    4 *
    DEG *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr))
  return { declination, rightAscension, equationOfTime: eot, apparentLongitude: lambda, distance }
}

function minutesOfUtcDay(utcMs: number): number {
  return mod(utcMs, 86_400_000) / 60_000
}

export interface SubsolarPoint {
  /** Latitude [deg]. */
  lat: number
  /** Longitude [deg, -180..180). */
  lon: number
}

/** Point on Earth where the sun is at the zenith: lat = δ, lon = −15(UTC_h − 12) − EoT/4. */
export function subsolarPoint(utcMs: number): SubsolarPoint {
  const { declination, equationOfTime } = solarCoordinates(utcMs)
  const lon = (720 - minutesOfUtcDay(utcMs) - equationOfTime) / 4
  return { lat: declination, lon: mod(lon + 180, 360) - 180 }
}

/** Unit vector toward the sun in ECEF (Z = north pole, X = prime meridian). */
export function sunDirectionEcef(utcMs: number, out = new Vector3()): Vector3 {
  const { lat, lon } = subsolarPoint(utcMs)
  const cl = Math.cos(lat * RAD)
  return out.set(cl * Math.cos(lon * RAD), cl * Math.sin(lon * RAD), Math.sin(lat * RAD))
}

/** Greenwich mean sidereal time [deg] (IAU 1982), used for the star field. */
export function gmstDegrees(utcMs: number): number {
  const jd = julianDay(utcMs)
  const T = (jd - 2_451_545) / 36_525
  return mod(
    280.46061837 + 360.98564736629 * (jd - 2_451_545) + T * T * (0.000387933 - T / 38_710_000),
    360,
  )
}

export interface SolarPosition {
  /** Geometric zenith angle [deg] (no refraction). */
  zenith: number
  /** Zenith angle corrected for atmospheric refraction [deg]. */
  apparentZenith: number
  /** Azimuth clockwise from north [deg]. */
  azimuth: number
  /** Hour angle [deg], 0 at local solar noon. */
  hourAngle: number
}

/**
 * Topocentric sun position at a location (NOAA formulation).
 * pressure [mbar] and temperature [°C] scale the refraction correction.
 */
export function solarPosition(
  utcMs: number,
  latDeg: number,
  lonDeg: number,
  pressure = 1010,
  temperature = 10,
): SolarPosition {
  const { declination, equationOfTime } = solarCoordinates(utcMs)
  const trueSolarTime = mod(minutesOfUtcDay(utcMs) + equationOfTime + 4 * lonDeg, 1440)
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180
  const phi = latDeg * RAD
  const dec = declination * RAD
  const ha = hourAngle * RAD
  const cosZ = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZ))) * DEG
  const sinZ = Math.sin(zenith * RAD)
  let azimuth: number
  if (sinZ < 1e-9) {
    azimuth = latDeg > declination ? 180 : 0
  } else {
    const cosAz = (Math.sin(phi) * cosZ - Math.sin(dec)) / (Math.cos(phi) * sinZ)
    const a = Math.acos(Math.max(-1, Math.min(1, cosAz))) * DEG
    azimuth = hourAngle > 0 ? mod(a + 180, 360) : mod(540 - a, 360)
  }
  const elevation = 90 - zenith
  return {
    zenith,
    apparentZenith: zenith - refractionDegrees(elevation, pressure, temperature),
    azimuth,
    hourAngle,
  }
}

/** Bennett (1982) refraction for a true elevation [deg], scaled by pressure/temperature. */
export function refractionDegrees(elevation: number, pressure = 1010, temperature = 10): number {
  if (elevation < -1.9) return 0
  const e = Math.max(elevation, -1.9)
  // Sæmundsson's inverse of Bennett: R [arcmin] for true altitude.
  const r = 1.02 / Math.tan((e + 10.3 / (e + 5.11)) * RAD)
  return ((r / 60) * (pressure / 1010) * 283) / (273 + temperature)
}
