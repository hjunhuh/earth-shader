// Sun optical depth lookup from the baked cubemap (bake/sunOpticalDepth).
// Channels hold the optical depth toward the sun from four reference
// heights; heights in between are interpolated linearly.
#include "common/cubemap"

uniform samplerCube uSunOD;
uniform vec4 uOdHeights;

float sunOpticalDepthAt(vec3 n, float h) {
  vec4 od = texture(uSunOD, warpEquiAngular(n));
  if (h <= uOdHeights.x) return od.x;
  if (h <= uOdHeights.y) return mix(od.x, od.y, (h - uOdHeights.x) / max(uOdHeights.y - uOdHeights.x, 1e-3));
  if (h <= uOdHeights.z) return mix(od.y, od.z, (h - uOdHeights.y) / max(uOdHeights.z - uOdHeights.y, 1e-3));
  if (h <= uOdHeights.w) return mix(od.z, od.w, (h - uOdHeights.z) / max(uOdHeights.w - uOdHeights.z, 1e-3));
  return od.w;
}
