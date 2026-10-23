#ifndef PI
#define PI 3.14159265358979
#endif
#define TAU 6.28318530717959
#define INV_PI 0.318309886183791
#define INV_4PI 0.0795774715459477

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }

float remap(float x, float a, float b, float c, float d) {
  return c + (x - a) * (d - c) / (b - a);
}
vec4 remap(vec4 x, vec4 a, vec4 b, vec4 c, vec4 d) {
  return c + (x - a) * (d - c) / (b - a);
}

float remapClamped(float x, float a, float b) {
  return saturate((x - a) / (b - a));
}
vec4 remapClamped(vec4 x, vec4 a, vec4 b) {
  return saturate((x - a) / (b - a));
}
// remapClamped(x, a, b) then into [c, d]
float remapClamped(float x, float a, float b, float c, float d) {
  return mix(c, d, remapClamped(x, a, b));
}

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float maxComponent(vec3 v) { return max(v.x, max(v.y, v.z)); }

// Interleaved gradient noise (Jimenez 2014).
float interleavedGradientNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// Hash without sine (Dave Hoskins), stable across GPUs.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
