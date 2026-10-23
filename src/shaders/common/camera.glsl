#include "common/intersect"

// Camera uniforms shared by all screen-space passes. Everything is in
// shading space (ECEF with z scaled by a/b) relative to the camera.
uniform mat3 uViewToShading;   // camera-space direction -> shading-space (unnormalized)
uniform mat3 uShadingToView;   // inverse of uViewToShading
uniform vec2 uTanHalfFov;      // (tan(fovX/2), tan(fovY/2))
uniform vec2 uResolution;      // render target size [px]
uniform vec2 uJitter;          // subpixel offset in NDC
uniform vec3 uCameraShading;   // camera position in shading space [m]
uniform float uCameraRadius;   // |uCameraShading| [m]
uniform float uCameraHeight;   // uCameraRadius - EARTH_RADIUS [m]
uniform float uEarthC;         // (|o| - a)(|o| + a)
uniform float uPixelAngle;     // angular size of one pixel [rad]

const float EARTH_RADIUS = 6378137.0;

vec2 fragNdc(vec2 fragCoord) {
  return (fragCoord / uResolution) * 2.0 - 1.0 + uJitter;
}

vec3 cameraRayDirection(vec2 ndc) {
  return normalize(uViewToShading * vec3(ndc * uTanHalfFov, -1.0));
}

// Projects a camera-relative shading-space point to NDC (z > 0 in front).
vec3 projectRelative(vec3 rel) {
  vec3 v = uShadingToView * rel;
  return vec3(v.xy / (-v.z * uTanHalfFov), -v.z);
}

// Distance to the ocean along a camera ray, or -1 on a miss.
float oceanDistance(vec3 dir) {
  vec2 t = raySphereStable(dot(uCameraShading, dir), uEarthC);
  if (t.y < 0.0) return -1.0;
  return t.x >= 0.0 ? t.x : -1.0;
}
