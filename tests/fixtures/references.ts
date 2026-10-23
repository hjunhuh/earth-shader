/**
 * Real-world reference data for measured (L3) tests. Bands are what the
 * literature supports for clear skies; tolerances are applied on top.
 */

/** Clear-sky horizontal illuminance [lux] vs solar elevation [deg] (daylight tables, e.g. Bond & Henderson 1963; IESNA). */
export const DAYLIGHT_ILLUMINANCE: { elevation: number; min: number; max: number }[] = [
  { elevation: 60, min: 8e4, max: 1.1e5 },
  { elevation: 30, min: 4e4, max: 7e4 },
  { elevation: 10, min: 8e3, max: 2e4 },
  { elevation: 5, min: 2.5e3, max: 8e3 },
]

/**
 * Twilight illuminance [lux] (AMS Glossary of Meteorology: sunset ≈ 400–600 lx,
 * end of civil twilight ≈ 3.4 lx, nautical ≈ 0.008 lx). Geometric elevation;
 * sunset = sun center at −0.833° (refraction + semidiameter).
 */
export const TWILIGHT_ILLUMINANCE: { elevation: number; min: number; max: number }[] = [
  { elevation: -0.833, min: 410, max: 585 },
  { elevation: -6, min: 2, max: 3.5 },
  { elevation: -12, min: 0.006, max: 0.01 },
]

/** Preetham et al. 1999 zenith luminance [kcd/m²] for turbidity T and solar elevation [deg]. */
export function preethamZenith(T: number, elevationDeg: number): number {
  const thetaS = ((90 - elevationDeg) * Math.PI) / 180
  const chi = (4 / 9 - T / 120) * (Math.PI - 2 * thetaS)
  return (4.0453 * T - 4.971) * Math.tan(chi) - 0.2155 * T + 2.4192
}

/** Krochmann & Seidl (1974) clear-sky zenith luminance [kcd/m²]. */
export function krochmannZenith(T: number, elevationDeg: number): number {
  return (1.376 * T - 1.81) * Math.tan((elevationDeg * Math.PI) / 180) + 0.38
}

/** Correlated color temperature of direct sunlight [K] vs elevation (loose literature bands). */
export const DIRECT_SUN_CCT: { elevation: number; min: number; max: number }[] = [
  { elevation: 60, min: 4800, max: 6200 },
  { elevation: 10, min: 2800, max: 4500 },
  { elevation: 2, min: 1500, max: 2800 },
]
