// Precompute pass 4d: scattering_sum += delta_multiple / RayleighPhase(nu)
// (ping-pong). With order == 1 it initializes the sum with single Rayleigh.
#include "atmosphere/functions"
uniform sampler3D previous_sum_texture;
uniform sampler3D delta_texture;
uniform int layer;
uniform int first;
layout(location = 0) out vec4 outValue;
void main() {
  ivec3 p = ivec3(ivec2(gl_FragCoord.xy), layer);
  vec3 delta = texelFetch(delta_texture, p, 0).rgb;
  if (first == 1) {
    outValue = vec4(delta, 1.0);
    return;
  }
  float r;
  float mu;
  float mu_s;
  float nu;
  bool ground;
  GetRMuMuSNuFromScatteringTextureFragCoord(ATMOSPHERE,
      vec3(gl_FragCoord.xy, float(layer) + 0.5), r, mu, mu_s, nu, ground);
  outValue = vec4(texelFetch(previous_sum_texture, p, 0).rgb + delta / RayleighPhaseFunction(nu), 1.0);
}
