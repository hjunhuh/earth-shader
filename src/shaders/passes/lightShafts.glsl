// Light shafts (report §3.12): shadowed fraction of each view ray's first
// uMaxDistance, Σ (1 − e^{−τ_i}) Δ_i / L, where τ_i is the cloud optical depth
// from the sample toward the sun. The background pass turns it back into
// Bruneton's shadow_length with its own (full-res) ray end, which avoids
// upsampling artifacts at the sky/ocean discontinuity.
#include "common/math"
#include "common/camera"
#include "clouds/lightMarch"

#ifndef LIGHT_SHAFT_SAMPLES
#define LIGHT_SHAFT_SAMPLES 64
#endif

uniform vec3 uSunDirection;
uniform float uMaxDistance;     // [m]
uniform float uFrame;
layout(location = 0) out vec4 outValue;

void main() {
  vec2 ndc = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  vec3 dir = cameraRayDirection(ndc);
  float tOcean = oceanDistance(dir);
  float tEnd = tOcean > 0.0 ? min(tOcean, uMaxDistance) : uMaxDistance;
  float dt = tEnd / float(LIGHT_SHAFT_SAMPLES);
  float jitter = interleavedGradientNoise(gl_FragCoord.xy + mod(uFrame, 64.0) * vec2(5.588, 3.191));
  float shadowed = 0.0;
  for (int i = 0; i < LIGHT_SHAFT_SAMPLES; ++i) {
    float t = (float(i) + jitter) * dt;
    vec3 p = uCameraShading + dir * t;
    float r = length(p);
    vec3 n = p / r;
    float h = r - SHADING_RADIUS;
    if (h > uGroups.w) continue; // above all clouds: always sunlit
    float fp = max(uPixelAngle * t, 200.0);
    float od = groupSunOpticalDepth(n, h, uSunDirection, uGroups.x, uGroups.y, 4, fp, 1.0);
    if (uGroupCount > 1) od += groupSunOpticalDepth(n, h, uSunDirection, uGroups.z, uGroups.w, 2, fp, 1.0);
    shadowed += (1.0 - exp(-od)) * dt;
  }
  outValue = vec4(shadowed / max(tEnd, 1.0), 0.0, 0.0, 1.0);
}
