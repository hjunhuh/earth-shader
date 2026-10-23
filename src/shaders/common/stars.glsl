// Procedural star field on the celestial sphere (inertial frame; the CPU
// rotates by GMST so stars turn with time). One candidate per cell; V
// magnitudes follow the observed cumulative count log10 N(<m) ≈ 0.48 m + 0.9
// (≈ 10k stars brighter than 6.5, brightest ≈ −1.9). Illuminance
// E = 2.08e-6 lx · 10^(−0.4 m), spread over about one pixel. kcd/m².
#include "common/noise"
#include "common/cubemap"

uniform mat3 uEcefToCelestial;   // rotation (ECEF -> inertial)

vec3 starField(vec3 dirEcef, float pixelAngle) {
  vec3 d = uEcefToCelestial * dirEcef;
  // Grid cells on the cube faces (~0.25° each), one candidate star per cell.
  vec3 a = abs(d);
  int face = a.x >= a.y && a.x >= a.z ? (d.x > 0.0 ? 0 : 1) : (a.y >= a.z ? (d.y > 0.0 ? 2 : 3) : (d.z > 0.0 ? 4 : 5));
  vec2 uv = face < 2 ? d.yz / a.x : (face < 4 ? d.xz / a.y : d.xy / a.z);
  const float CELLS = 360.0;
  vec2 cell = floor((uv * 0.5 + 0.5) * CELLS);
  vec3 h = hash33(ivec3(int(cell.x), int(cell.y), face), 4096, 77u);
  float m = (log2(max(h.z, 1e-9) * CELLS * CELLS * 6.0) * 0.30103 - 0.9) / 0.48;
  if (m > 6.5) return vec3(0.0);
  vec2 center = (cell + 0.2 + 0.6 * h.xy) / CELLS * 2.0 - 1.0;
  vec3 starDir = normalize(face < 2 ? vec3(sign(d.x), center) : (face < 4 ? vec3(center.x, sign(d.y), center.y) : vec3(center, sign(d.z))));
  float angle = acos(clamp(dot(d, starDir), -1.0, 1.0));
  // Gaussian point spread of about one pixel.
  float w = exp(-0.5 * pow(angle / (0.6 * pixelAngle), 2.0));
  float E = 2.08e-6 * pow(10.0, -0.4 * m);
  float L = E / (2.0 * 3.14159 * pow(0.6 * pixelAngle, 2.0)) * w;
  // Color temperature spread (blue-white to orange).
  vec3 tint = mix(vec3(1.0, 0.82, 0.62), vec3(0.78, 0.86, 1.0), fract(h.x * 7.0 + h.y * 3.0));
  return tint * L * 0.001;
}
