// Precompute pass 4b: indirect irradiance for order n-1. Writes the delta
// (location 0) and the running sum (location 1 = previous sum + delta);
// ping-pong instead of additive float blending.
#include "atmosphere/functions"
uniform sampler3D single_rayleigh_scattering_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D multiple_scattering_texture;
uniform sampler2D previous_irradiance_texture;
uniform int scattering_order;
uniform int first;
layout(location = 0) out vec4 outDelta;
layout(location = 1) out vec4 outSum;
void main() {
  vec3 delta = ComputeIndirectIrradianceTexture(
      ATMOSPHERE, single_rayleigh_scattering_texture,
      single_mie_scattering_texture, multiple_scattering_texture,
      gl_FragCoord.xy, scattering_order);
  outDelta = vec4(delta, 1.0);
  vec3 previous = first == 1 ? vec3(0.0) : texelFetch(previous_irradiance_texture, ivec2(gl_FragCoord.xy), 0).rgb;
  outSum = vec4(previous + delta, 1.0);
}
