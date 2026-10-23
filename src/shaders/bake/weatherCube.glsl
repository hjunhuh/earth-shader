// Global weather cubemap (equi-angular faces): per-layer local cloudiness
// in rgb = (low, mid, cirrus). Domain-warped noise on the unit sphere
// (no UV seams or pole singularities) biased by a latitude climatology
// (mirrors src/clouds/weather.ts climatology()).
#include "common/math"
#include "common/cubemap"
#include "common/noise"

uniform int uFace;
uniform float uSize;
uniform uint uSeed;
layout(location = 0) out vec4 outValue;

float gauss(float x, float mu, float sigma) {
  float d = (x - mu) / sigma;
  return exp(-0.5 * d * d);
}

vec3 climatology(float latDeg) {
  float itcz = gauss(latDeg, 5.0, 7.0);
  float subtropics = gauss(latDeg, 25.0, 8.0) + gauss(latDeg, -25.0, 8.0);
  float storms = gauss(latDeg, 52.0, 12.0) + gauss(latDeg, -52.0, 12.0);
  float polar = gauss(latDeg, 80.0, 10.0) + gauss(latDeg, -80.0, 10.0);
  return saturate(vec3(
    0.45 + 0.25 * itcz - 0.15 * subtropics + 0.25 * storms + 0.05 * polar,
    0.35 + 0.35 * itcz - 0.30 * subtropics + 0.30 * storms,
    0.30 + 0.40 * itcz - 0.25 * subtropics + 0.25 * storms - 0.10 * polar));
}

float noise01(vec3 p, int period, int octaves, uint seed) {
  return perlinFbm(p, period, octaves, seed) * 0.5 + 0.5;
}

void main() {
  vec2 w = gl_FragCoord.xy / uSize * 2.0 - 1.0;
  vec3 n = equiAngularFaceDirection(uFace, w);
  float latDeg = degrees(asin(clamp(n.z, -1.0, 1.0)));
  // Large-scale domain warp, stronger in the storm tracks (swirling fronts).
  float stormBand = gauss(abs(latDeg), 50.0, 15.0);
  vec3 warp = vec3(
    perlinFbm(n * 2.0 + vec3(1.3, 7.1, 3.7), 256, 3, uSeed),
    perlinFbm(n * 2.0 + vec3(5.2, 1.9, 8.3), 256, 3, uSeed + 1u),
    perlinFbm(n * 2.0 + vec3(9.4, 4.6, 2.2), 256, 3, uSeed + 2u));
  vec3 q = n + warp * (0.18 + 0.25 * stormBand);
  // Zonal stretching: features elongated east-west like real cloud bands.
  vec3 qz = vec3(q.xy * 0.75, q.z * 1.6);
  float systems = noise01(qz * 3.0, 256, 4, uSeed + 10u);
  float clusters = noise01(q * 18.0, 512, 4, uSeed + 20u);
  float cells = noise01(q * 70.0, 1024, 3, uSeed + 30u);
  vec3 clim = climatology(latDeg);
  float low = clim.x + (systems - 0.5) * 0.9 + (clusters - 0.5) * 0.55 + (cells - 0.5) * 0.35;
  float mid = clim.y + (systems - 0.5) * 1.0 + (clusters - 0.5) * 0.45;
  float cirrusStreaks = noise01(vec3(q.xy * 40.0, q.z * 8.0) + 3.0, 512, 3, uSeed + 40u);
  float cirrus = clim.z + (systems - 0.5) * 0.8 + (cirrusStreaks - 0.5) * 0.7;
  // Contrast so cloudy columns reach full layer height and clear areas
  // vanish (otherwise most clouds become thin sheets at the S(f) peak).
  vec3 v = saturate((vec3(low, mid, cirrus) - 0.5) * 1.8 + 0.5);
  outValue = vec4(v, 1.0);
}
