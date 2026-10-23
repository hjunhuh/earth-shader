// Exposure meter: center-weighted log2 luminance moments (kcd/m², white
// balanced) into a power-of-two target whose 1x1 mip holds the weighted
// means. Out: (w·log2 L, w, w·(log2 L)², 1). Near-black pixels get no weight.
#include "common/math"
uniform sampler2D uHdr;
uniform vec3 uWhitePoint;
uniform vec2 uSize;
layout(location = 0) out vec4 outValue;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 c = textureLod(uHdr, uv, 0.0).rgb / uWhitePoint;
  float L = luminance(c);
  vec2 ndc = uv * 2.0 - 1.0;
  float w = exp(-dot(ndc, ndc) * 1.5) * step(1e-7, L);
  float l = log2(max(L, 1e-7));
  outValue = vec4(w * l, w, w * l * l, 1.0);
}
