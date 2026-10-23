// Precompute pass 3: single Rayleigh (component 0) or Mie (component 1)
// scattering for one layer of the 3D table. Split per output because 3D
// render targets do not support multiple attachments in three.js.
#include "atmosphere/functions"
uniform sampler2D transmittance_texture;
uniform int layer;
uniform int component;
layout(location = 0) out vec4 outValue;
void main() {
  vec3 rayleigh;
  vec3 mie;
  ComputeSingleScatteringTexture(ATMOSPHERE, transmittance_texture,
      vec3(gl_FragCoord.xy, float(layer) + 0.5), rayleigh, mie);
  outValue = vec4(component == 0 ? rayleigh : mie, 1.0);
}
