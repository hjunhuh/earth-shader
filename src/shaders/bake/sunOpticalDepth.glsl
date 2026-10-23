// Sun optical depth cubemap (equi-angular): for each direction n and four
// reference heights (uHeights), the cloud optical depth along the sun ray
// through the cloud shell, from the 2.5D density. Gives O(1) far self-shadow
// for cloud samples and ocean shadows seen from space.
#include "clouds/density"

uniform int uFace;
uniform float uSize;
uniform vec3 uSunDirection;  // shading space, unit
uniform vec4 uHeights;       // reference heights [m]
uniform int uSteps;
layout(location = 0) out vec4 outValue;

// Distance along the ray from height h (radius R+h) with cosine mu to the
// sphere of height H, outward root; c-term formed without cancellation.
float distanceToHeight(float h, float mu, float H) {
  float r = SHADING_RADIUS + h;
  float b = r * mu;
  float c = (h - H) * (2.0 * SHADING_RADIUS + h + H);
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  return -b + sqrt(disc);
}

// Optical depth along the sun ray through one layer group [hMin, hMax].
float groupOpticalDepth(vec3 n, float h, float mu, float hMin, float hMax) {
  if (h > hMax) return 0.0;
  float t0 = h < hMin ? distanceToHeight(h, mu, hMin) : 0.0;
  float t1 = distanceToHeight(h, mu, hMax);
  if (t0 < 0.0 || t1 <= t0) return 0.0;
  vec3 origin = n * (SHADING_RADIUS + h);
  float dt = (t1 - t0) / float(uSteps);
  float od = 0.0;
  for (int i = 0; i < 64; ++i) {
    if (i >= uSteps) break;
    vec3 x = origin + uSunDirection * (t0 + (float(i) + 0.5) * dt);
    float rx = length(x);
    vec4 s = cloudExtinction25(x / rx, rx - SHADING_RADIUS, 1.0) * uShadowMask;
    od += dot(s, vec4(1.0)) * dt;
  }
  return od;
}

float opticalDepthFrom(vec3 n, float h) {
  float mu = dot(n, uSunDirection);
  // Sun below the local horizon of the ocean sphere: no direct sunlight anyway.
  float r = SHADING_RADIUS + h;
  float horizon = -sqrt(max(0.0, 1.0 - (SHADING_RADIUS / r) * (SHADING_RADIUS / r)));
  if (mu < horizon) return 0.0;
  float od = groupOpticalDepth(n, h, mu, uGroups.x, uGroups.y);
  if (uGroupCount > 1) od += groupOpticalDepth(n, h, mu, uGroups.z, uGroups.w);
  return od;
}

void main() {
  vec2 w = gl_FragCoord.xy / uSize * 2.0 - 1.0;
  vec3 n = equiAngularFaceDirection(uFace, w);
  outValue = vec4(
    opticalDepthFrom(n, uHeights.x),
    opticalDepthFrom(n, uHeights.y),
    opticalDepthFrom(n, uHeights.z),
    opticalDepthFrom(n, uHeights.w));
}
