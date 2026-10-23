// Precompute pass 4a: scattering density for order n (one layer).
#include "atmosphere/functions"
uniform sampler2D transmittance_texture;
uniform sampler3D single_rayleigh_scattering_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D multiple_scattering_texture;
uniform sampler2D irradiance_texture;
uniform int scattering_order;
uniform int layer;
layout(location = 0) out vec4 outValue;
void main() {
  outValue = vec4(ComputeScatteringDensityTexture(
      ATMOSPHERE, transmittance_texture, single_rayleigh_scattering_texture,
      single_mie_scattering_texture, multiple_scattering_texture,
      irradiance_texture, vec3(gl_FragCoord.xy, float(layer) + 0.5),
      scattering_order), 1.0);
}
