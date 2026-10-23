// 3D detail noise (Worley fBm), tileable, one layer per draw.
#include "common/math"
#include "common/noise"
uniform int uLayer;
uniform float uSize;
layout(location = 0) out vec4 outValue;
void main() {
  vec3 p = vec3(gl_FragCoord.xy, float(uLayer) + 0.5) / uSize;
  outValue = vec4(worleyFbm(p, 2, 404u), worleyFbm(p, 4, 505u), 0.0, 1.0);
}
