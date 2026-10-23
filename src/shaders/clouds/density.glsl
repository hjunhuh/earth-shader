// Cloud density model (report §2) evaluated on vec4s: one channel per layer.
// Positions are in shading space: `n` is the unit direction from the planet
// center, `h` the height above the ocean sphere [m]. Returns the extinction
// coefficient σ_t [1/m] per layer.
#include "common/math"
#include "common/cubemap"

uniform samplerCube uWeather;     // per-layer local cloudiness (rgb), equi-angular
uniform float uCoverage;          // global coverage control [0, 1]
uniform vec4 uMinHeights;
uniform vec4 uMaxHeights;
uniform vec4 uDensityScales;
uniform vec4 uShapeAmounts;
uniform vec4 uDetailAmounts;
uniform vec4 uWeatherExponents;
uniform vec4 uShapeAlteringBiases;
uniform vec4 uCoverageFilterWidths;
uniform vec4 uProfileExpTerms;
uniform vec4 uProfileExponents;
uniform vec4 uProfileLinearTerms;
uniform vec4 uProfileConstantTerms;
uniform vec4 uShadowMask;
uniform vec2 uShell;              // overall [min, max] height of all layers
uniform vec4 uGroups;             // merged layer intervals: (min0, max0, min1, max1) [m]
uniform int uGroupCount;          // 1 or 2
// 3D noise (tileable, mipmapped): coordinates are camera-relative positions
// divided by the period plus a CPU (float64) offset fract(camera / period).
uniform sampler3D uShape;
uniform sampler3D uDetail;
uniform float uShapePeriod;       // [m]
uniform float uDetailPeriod;      // [m]
uniform vec3 uShapeOffset;
uniform vec3 uDetailOffset;
uniform vec3 uCameraShadingDensity; // camera position (shading space) for pRel
// Synthetic weather (tests): slab (bottom, top, σ, -), blob (bottom, top, radius, σ).
uniform vec4 uSynthParams;
uniform vec3 uSynthCenter;        // blob center direction (shading space, unit)

#ifndef WEATHER_MODE
#define WEATHER_MODE 0
#endif

const float SHADING_RADIUS = 6378137.0;

vec4 heightFractions(float h) {
  return (vec4(h) - uMinHeights) / max(uMaxHeights - uMinHeights, vec4(1e-3));
}

vec4 shapeAlteringFn(vec4 f, vec4 bias) {
  vec4 x = 2.0 * pow(max(f, vec4(1e-6)), bias) - 1.0;
  return 1.0 - x * x;
}

vec4 densityProfile(vec4 f) {
  return max(uProfileExpTerms * exp(uProfileExponents * f) + uProfileLinearTerms * f + uProfileConstantTerms, vec4(0.0));
}

vec4 sampleWeather(vec3 n) {
  return textureLod(uWeather, warpEquiAngular(n), 0.0);
}

vec4 sampleWeatherLod(vec3 n, float lod) {
  return textureLod(uWeather, warpEquiAngular(n), lod);
}

// Coverage-shaped base density per layer from the 2D weather (report §2.3):
// factor = 1 − coverage·S(f); ρ = remapClamped(w, factor, factor + filterWidth).
vec4 baseDensity(vec4 weather, vec4 f) {
  vec4 inside = step(vec4(0.0), f) * step(f, vec4(1.0));
  vec4 w = pow(saturate(weather), uWeatherExponents);
  vec4 factor = 1.0 - uCoverage * shapeAlteringFn(saturate(f), uShapeAlteringBiases);
  vec4 rho = saturate((w - factor) / max(uCoverageFilterWidths, vec4(1e-3)));
  return rho * inside;
}

#if WEATHER_MODE == 2
vec4 syntheticExtinction(vec3 n, float h) {
  float inside = step(uSynthParams.x, h) * step(h, uSynthParams.y);
  return vec4(uSynthParams.z * inside, 0.0, 0.0, 0.0);
}
#elif WEATHER_MODE == 3
vec4 syntheticExtinction(vec3 n, float h) {
  float inside = step(uSynthParams.x, h) * step(h, uSynthParams.y);
  // Chord length: acos(dot) cannot resolve km-scale angles in float32.
  float dist = length(n - uSynthCenter) * SHADING_RADIUS;
  float edge = 1.0 - smoothstep(uSynthParams.z * 0.85, uSynthParams.z, dist);
  return vec4(uSynthParams.w * inside * edge, 0.0, 0.0, 0.0);
}
#endif

// Erosion by a shape value S ∈ [0, 1] (report §2.4): remapClamped(ρ, (1 − S)·a, 1).
vec4 erode(vec4 rho, float shape, vec4 amount) {
  vec4 lo = (1.0 - shape) * amount;
  return saturate((rho - lo) / max(1.0 - lo, vec4(1e-3)));
}

// Mean of the shape noise (its 1×1×1 mip): the limit of erosion at distance.
float meanShape() {
  return textureLod(uShape, vec3(0.5), 7.0).r;
}

// 2.5D extinction (weather × vertical profile × mean erosion, no 3D noise):
// the far-field limit of cloudExtinction3D (used by the sun optical depth
// bake and distant samples).
vec4 cloudExtinction25(vec3 n, float h, float weatherLod) {
#if WEATHER_MODE == 1
  return vec4(0.0);
#elif WEATHER_MODE >= 2
  return syntheticExtinction(n, h);
#else
  if (h < uShell.x || h > uShell.y) return vec4(0.0);
  vec4 f = heightFractions(h);
  vec4 rho = baseDensity(sampleWeatherLod(n, weatherLod), f);
  rho = erode(rho, meanShape(), uShapeAmounts);
  return rho * densityProfile(saturate(f)) * uDensityScales;
#endif
}

// Full 3D extinction. pRel = sample position relative to the camera (shading
// space); footprint = pixel footprint at the sample [m]. Noise is sampled at
// a footprint-based mip so erosion converges to its mean with distance and
// matches cloudExtinction25 continuously (no LOD pop).
vec4 cloudExtinction3D(vec3 n, float h, vec3 pRel, float footprint, float weatherLod, bool detail) {
#if WEATHER_MODE == 1
  return vec4(0.0);
#elif WEATHER_MODE >= 2
  return syntheticExtinction(n, h);
#else
  if (h < uShell.x || h > uShell.y) return vec4(0.0);
  vec4 f = heightFractions(h);
  vec4 rho = baseDensity(sampleWeatherLod(n, weatherLod), f);
  if (dot(rho, vec4(1.0)) <= 0.0) return vec4(0.0);
  float shapeLod = log2(max(1.0, footprint / (uShapePeriod / 128.0)));
  float shape = textureLod(uShape, pRel / uShapePeriod + uShapeOffset, shapeLod).r;
  rho = erode(rho, shape, uShapeAmounts);
#ifdef SHAPE_DETAIL
  float detailLod = log2(max(1.0, footprint / (uDetailPeriod / 32.0)));
  // Detail fades out between mip 2 and 4 (the far field has none), so the
  // transition is continuous.
  float detailWeight = 1.0 - smoothstep(2.0, 4.0, detailLod);
  if (detail && detailWeight > 0.0 && dot(rho, vec4(1.0)) > 0.0) {
    float d = textureLod(uDetail, pRel / uDetailPeriod + uDetailOffset, detailLod).r;
    // Wispy bases, billowy tops (report §2.4).
    vec4 mod4 = mix(vec4(pow(d, 6.0)), vec4(1.0 - d), saturate((f - 0.2) / 0.2));
    vec4 lo = mod4 * 0.35 * uDetailAmounts * detailWeight;
    rho = saturate((rho - lo) / max(1.0 - lo, vec4(1e-3)));
  }
#endif
  return rho * densityProfile(saturate(f)) * uDensityScales;
#endif
}
