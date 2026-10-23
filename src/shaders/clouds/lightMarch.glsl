// Optical depth toward the sun by marching the cloud density (needs
// clouds/density). Used for ocean shadows (every ocean pixel, any altitude)
// and for the near part of cloud self-shadowing.
#include "clouds/density"

// Distance from height h along a ray with radial cosine mu to height H
// (outward root), with the c-term formed without cancellation.
float distanceToHeightFrom(float h, float mu, float H) {
  float r = SHADING_RADIUS + h;
  float b = r * mu;
  float c = (h - H) * (2.0 * SHADING_RADIUS + h + H);
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  return -b + sqrt(disc);
}

// Density for shadow rays: 3D shape (no detail) at the given footprint, so
// shadows match the visible cloud shapes up close and average out far away.
float shadowExtinction(vec3 x, float footprint, float lod) {
  float rx = length(x);
  return dot(cloudExtinction3D(x / rx, rx - SHADING_RADIUS, x - uCameraShadingDensity, footprint, lod, false) * uShadowMask, vec4(1.0));
}

// Optical depth through one layer group along the sun ray from (n, h).
float groupSunOpticalDepth(vec3 n, float h, vec3 sun, float hMin, float hMax, int steps, float footprint, float lod) {
  if (h > hMax) return 0.0;
  float mu = dot(n, sun);
  float t0 = h < hMin ? distanceToHeightFrom(h, mu, hMin) : 0.0;
  float t1 = distanceToHeightFrom(h, mu, hMax);
  if (t0 < 0.0 || t1 <= t0) return 0.0;
  vec3 origin = n * (SHADING_RADIUS + h);
  float dt = (t1 - t0) / float(steps);
  float od = 0.0;
  for (int i = 0; i < 32; ++i) {
    if (i >= steps) break;
    vec3 x = origin + sun * (t0 + (float(i) + 0.5) * dt);
    od += shadowExtinction(x, footprint, lod) * dt;
  }
  return od;
}

// Total cloud optical depth along the sun ray from a surface point.
float surfaceSunOpticalDepth(vec3 n, vec3 sun, int steps, float footprint, float lod) {
  float od = groupSunOpticalDepth(n, 0.0, sun, uGroups.x, uGroups.y, steps, footprint, lod);
  if (uGroupCount > 1) od += groupSunOpticalDepth(n, 0.0, sun, uGroups.z, uGroups.w, steps, footprint, lod);
  return od;
}

// Near light march from a cloud sample: steps of 60 m · 2^i toward the sun.
// Returns (optical depth, distance covered).
vec2 nearSunOpticalDepth(vec3 p, vec3 sun, int steps, float footprint, float lod) {
  float od = 0.0;
  float t = 0.0;
  float ds = 60.0;
  for (int i = 0; i < 8; ++i) {
    if (i >= steps) break;
    vec3 x = p + sun * (t + 0.5 * ds);
    od += shadowExtinction(x, max(footprint, ds), lod) * ds;
    t += ds;
    ds *= 2.0;
  }
  return vec2(od, t);
}
