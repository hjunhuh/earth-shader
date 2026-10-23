// 3D shape noise (Perlin-Worley, HZD-style), tileable, one layer per draw.
#include "common/math"
#include "common/noise"
uniform int uLayer;
uniform float uSize;
layout(location = 0) out vec4 outValue;
void main() {
  vec3 p = vec3(gl_FragCoord.xy, float(uLayer) + 0.5) / uSize;
  float perlin = perlinFbm(p * 4.0, 4, 3, 101u) * 0.5 + 0.5;
  float worley = worleyFbm(p, 4, 202u);
  // Perlin-Worley: perlin remapped into the worley range (billowy cells).
  float pw = saturate(remap(perlin, worley - 1.0, 1.0, 0.0, 1.0));
  float worley2 = worleyFbm(p, 8, 303u);
  float shape = saturate(remap(pw, worley2 * 0.6 - 0.6, 1.0, 0.0, 1.0));
  outValue = vec4(shape, pw, worley2, 1.0);
}
