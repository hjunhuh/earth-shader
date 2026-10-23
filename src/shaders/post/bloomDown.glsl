// Bloom downsample (13-tap, Jimenez 2014). On the first level a Karis
// average (1 / (1 + luma)) suppresses fireflies from the sun disk / glint.
#include "common/math"
uniform sampler2D uSource;
uniform vec2 uSourceTexel;  // 1 / source size
uniform vec2 uTargetSize;
uniform int uKaris;
layout(location = 0) out vec4 outValue;

vec3 karis(vec3 c) {
  return c / (1.0 + luminance(c));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uTargetSize;
  vec2 t = uSourceTexel;
  vec3 a = texture(uSource, uv + t * vec2(-2.0, 2.0)).rgb;
  vec3 b = texture(uSource, uv + t * vec2(0.0, 2.0)).rgb;
  vec3 c = texture(uSource, uv + t * vec2(2.0, 2.0)).rgb;
  vec3 d = texture(uSource, uv + t * vec2(-2.0, 0.0)).rgb;
  vec3 e = texture(uSource, uv).rgb;
  vec3 f = texture(uSource, uv + t * vec2(2.0, 0.0)).rgb;
  vec3 g = texture(uSource, uv + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(uSource, uv + t * vec2(0.0, -2.0)).rgb;
  vec3 i = texture(uSource, uv + t * vec2(2.0, -2.0)).rgb;
  vec3 j = texture(uSource, uv + t * vec2(-1.0, 1.0)).rgb;
  vec3 k = texture(uSource, uv + t * vec2(1.0, 1.0)).rgb;
  vec3 l = texture(uSource, uv + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(uSource, uv + t * vec2(1.0, -1.0)).rgb;
  vec3 result;
  if (uKaris == 1) {
    vec3 g0 = karis((a + b + d + e) * 0.25);
    vec3 g1 = karis((b + c + e + f) * 0.25);
    vec3 g2 = karis((d + e + g + h) * 0.25);
    vec3 g3 = karis((e + f + h + i) * 0.25);
    vec3 g4 = karis((j + k + l + m) * 0.25);
    result = 0.125 * (g0 + g1 + g2 + g3) + 0.5 * g4;
    // Undo the Karis weighting of the average.
    result = result / max(1.0 - luminance(result), 1e-4);
  } else {
    result = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  outValue = vec4(result, 1.0);
}
