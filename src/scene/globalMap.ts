import { Uniform, type Texture } from 'three'

/**
 * The whole-Earth map (NASA Blue Marble Next Generation, 8192×4096 simple
 * cylindrical, see scripts/prepare-earth-textures.mjs) and its blend with the
 * map tiles.
 *
 * From afar the tiles are low zoom levels: blocky, seamed and slow to arrive.
 * One global texture with mipmaps is smooth at any distance, so each pixel
 * shows it where the ground it covers is coarser than the texture's own
 * pixels could resolve better than the tiles: where a screen pixel spans more
 * than GLOBAL_MAP_BLEND[0] meters it starts to blend in, from [1] it is all.
 */

/*
 * Open sea shows the global map's ocean at every distance: EOX's mosaic puts
 * real coastal water on a different open-sea fill, a visible band along every
 * coast. Where the sea is deeper than ~10–60 m is a global mask
 * (opensea.png, baked from Terrarium bathymetry by the same script): one
 * texture, so it never changes between tiles or zoom levels (the tiles' own
 * elevation can't: from z11 Terrarium reads 0 m on coastal water).
 */

/** Blue Marble texel at the equator: 2π·a / 8192 ≈ 4.9 km. */
export const GLOBAL_MAP_TEXEL = (2 * Math.PI * 6378137) / 8192
/** Meters of ground per screen pixel where the global map starts / takes over. */
export const GLOBAL_MAP_BLEND = [0.3 * GLOBAL_MAP_TEXEL, 0.7 * GLOBAL_MAP_TEXEL] as const

export interface GlobalMapUniforms {
  [key: string]: Uniform
  globalMap: Uniform<Texture | null>
  /** Open-sea weight (red channel), same simple cylindrical layout. */
  openSeaMask: Uniform<Texture | null>
  /** 0: off (no texture yet, or the app's plain ocean). */
  globalMapEnabled: Uniform<number>
}

export function createGlobalMapUniforms(): GlobalMapUniforms {
  return { globalMap: new Uniform(null), openSeaMask: new Uniform(null), globalMapEnabled: new Uniform(0) }
}

/**
 * GLSL: `globalMapColor(ecef)` samples the map at an ECEF point (meters) on or
 * near the WGS84 surface; `globalMapWeight(ecef)` is its share there (0–1),
 * from the ground one pixel spans; `globalMapOpenSea(ecef)` is 1 over open
 * sea. Fragment stage only (derivatives).
 */
export const globalMapGLSL = /* glsl */ `
uniform sampler2D globalMap;
uniform sampler2D openSeaMask;
uniform float globalMapEnabled;

vec2 globalMapUv(const vec3 ecef) {
  // Geodetic latitude, exact on the ellipsoid surface.
  const float E2 = 0.00669437999014;
  float longitude = atan(ecef.y, ecef.x);
  float latitude = atan(ecef.z, (1.0 - E2) * length(ecef.xy));
  // Two longitude parameterizations with their seams half a turn apart; the
  // one continuous across this pixel quad keeps the mip level right at ±180°.
  float x = longitude * 0.15915494309189535 + 0.5;
  float u1 = fract(x);
  float u2 = fract(x + 0.5) - 0.5;
  float u = fwidth(u1) <= fwidth(u2) + 1e-6 ? u1 : u2;
  return vec2(u, latitude * 0.3183098861837907 + 0.5);
}

vec3 globalMapColor(const vec3 ecef) {
  return texture(globalMap, globalMapUv(ecef)).rgb;
}

float globalMapOpenSea(const vec3 ecef) {
  return globalMapEnabled * texture(openSeaMask, globalMapUv(ecef)).r;
}

float globalMapWeight(const vec3 ecef) {
  float metersPerPixel = length(fwidth(ecef));
  return globalMapEnabled * smoothstep(${GLOBAL_MAP_BLEND[0].toFixed(1)}, ${GLOBAL_MAP_BLEND[1].toFixed(1)}, metersPerPixel);
}
`
