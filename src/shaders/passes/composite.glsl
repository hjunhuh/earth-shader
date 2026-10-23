// Final pass: HDR (kcd/m²) -> exposure -> AgX -> sRGB with triangular dither.
#include "common/math"
#include "post/tonemap"

uniform sampler2D uHdr;
uniform sampler2D uExposureEv; // 1x1 EV100 from the auto-exposure pass
uniform float uManualEv;       // used when uAutoExposure == 0
uniform int uAutoExposure;
uniform vec3 uWhitePoint;      // camera white balance (solar spectrum -> neutral)
uniform vec2 uOutputSize;
uniform sampler2D uBloom;
uniform float uBloomStrength;  // fraction of energy redistributed by the lens
uniform float uFrame;

layout(location = 0) out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uOutputSize;
  vec3 hdr = mix(texture(uHdr, uv).rgb, texture(uBloom, uv).rgb / 6.0, uBloomStrength);
  float ev = uAutoExposure == 1 ? texelFetch(uExposureEv, ivec2(0), 0).r : uManualEv;
  // Buffer unit is kcd/m²: L[cd/m²] / (1.2 · 2^EV100).
  float exposure = 1000.0 / (1.2 * exp2(ev));
  vec3 mapped = agx(hdr / uWhitePoint * exposure);
  vec3 srgb = linearToSrgb(saturate(mapped));
  // Triangular-PDF dither (±1 LSB) to hide banding in twilight gradients.
  float n0 = hash12(gl_FragCoord.xy + uFrame * 17.0);
  float n1 = hash12(gl_FragCoord.yx + uFrame * 31.0 + 7.0);
  srgb += (n0 + n1 - 1.0) / 255.0;
  outColor = vec4(srgb, 1.0);
}
