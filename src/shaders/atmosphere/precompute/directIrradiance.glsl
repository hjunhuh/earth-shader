// Precompute pass 2: direct (sun) irradiance -> delta irradiance.
#include "atmosphere/functions"
uniform sampler2D transmittance_texture;
layout(location = 0) out vec4 outValue;
void main() {
  outValue = vec4(ComputeDirectIrradianceTexture(ATMOSPHERE, transmittance_texture, gl_FragCoord.xy), 1.0);
}
