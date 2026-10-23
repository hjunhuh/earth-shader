// Cloud lighting (per sample). Mirrors tests/reference/cloudLighting.ts.
//
// J = E_sun · Σ_i a^i P^i p(θ; c^i g) e^(−b^i τ_s)            (octaves, report §3.7)
//     P = 1 − e^(−τ_c): chance of a further scattering in the column (thin
//     clouds have little multiple scattering; the plain octave sum assumes
//     optically thick media)
//   + E_sun/π · A · [w R(τ_c)(1 − f) + (1 − w) T_d(τ_c) f]      (diffusion term)
//     f = τ_s/τ_c (relative depth), w = (1 − cosθ)/2 (viewer on the sun side)
//   + ambient (sky illuminance)
//
// The octave sum alone loses energy in thick clouds (reflectance ~0.2 where
// real clouds reach 0.6–0.9). The diffusion term uses the two-stream
// (Lacis–Hansen) reflectance R(τ) = 0.13τ/(1 + 0.13τ) and the diffuse
// transmittance T_d = 1 − R − e^(−τ) of the column through the sample (τ_c,
// along the sun). The up-going stream (∝ R, strongest near the top) is seen
// by viewers on the sun side, the down-going stream (∝ T_d, strongest near
// the base) by viewers on the far side. Tops are bright, bases dark, thin
// clouds translucent. A is calibrated against Lacis–Hansen (unit test).
#include "common/math"

#ifndef MS_OCTAVES
#define MS_OCTAVES 6
#endif

const float CLOUD_G_FORWARD = 0.7;
const float CLOUD_G_BACK = -0.2;
const float CLOUD_LOBE_MIX = 0.5;
const float MS_A = 0.1;   // energy per octave (calibrated with DIFFUSION_A)
const float MS_B = 0.5;   // attenuation per octave
const float MS_C = 0.5;   // eccentricity per octave
const float DIFFUSION_A = 0.80; // calibrated: slab R within +0.06 of Lacis–Hansen for τ ∈ [1, 50]

float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  return INV_4PI * (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-6), 1.5);
}

float dualLobePhase(float cosTheta, float scale) {
  return mix(henyeyGreenstein(cosTheta, CLOUD_G_FORWARD * scale),
             henyeyGreenstein(cosTheta, CLOUD_G_BACK * scale), CLOUD_LOBE_MIX);
}

float octaveScattering(float cosTheta, float tauSun, float tauColumn) {
  float P = 1.0 - exp(-tauColumn);
  float sum = 0.0;
  float a = 1.0;
  float b = 1.0;
  float c = 1.0;
  for (int i = 0; i < MS_OCTAVES; ++i) {
    sum += a * dualLobePhase(cosTheta, c) * exp(-b * tauSun);
    a *= MS_A * P;
    b *= MS_B;
    c *= MS_C;
  }
  return sum;
}

float lacisHansenReflectance(float tau) {
  return 0.13 * tau / (1.0 + 0.13 * tau);
}

// Per-unit-σ in-scattered luminance (multiply by σ_s for the source term).
vec3 cloudSourceFunction(vec3 sunIlluminance, vec3 skyIlluminance, float cosTheta,
                         float tauSun, float tauColumn, float heightFraction) {
  float tc = max(tauColumn, tauSun + 1e-4);
  float octaves = octaveScattering(cosTheta, tauSun, tc);
  float f = saturate(tauSun / tc);
  float R = lacisHansenReflectance(tc);
  float Td = max(0.0, 1.0 - R - exp(-tc));
  float w = 0.5 - 0.5 * cosTheta;
  float diffusion = DIFFUSION_A * INV_PI * (w * R * (1.0 - f) + (1.0 - w) * Td * f);
  // Sky light: upper parts see more of the sky dome.
  float skyWeight = INV_PI * 0.5 * (0.6 + 0.4 * heightFraction);
  return sunIlluminance * (octaves + diffusion) + skyIlluminance * skyWeight;
}
