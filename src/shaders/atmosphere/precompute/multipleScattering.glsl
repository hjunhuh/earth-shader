// Precompute pass 4c: multiple scattering of order n (one layer).
#include "atmosphere/functions"
uniform sampler2D transmittance_texture;
uniform sampler3D scattering_density_texture;
uniform int layer;
layout(location = 0) out vec4 outValue;
void main() {
  float nu;
  outValue = vec4(ComputeMultipleScatteringTexture(
      ATMOSPHERE, transmittance_texture, scattering_density_texture,
      vec3(gl_FragCoord.xy, float(layer) + 0.5), nu), 1.0);
}
