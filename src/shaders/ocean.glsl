// Ocean surface BRDF: GGX specular (Smith height-correlated visibility,
// Schlick Fresnel with water F0 = 0.02) plus a Lambertian water-leaving
// term weighted by the Fresnel transmission in and out. Mirrors
// tests/reference/oceanBrdf.ts.
#include "common/math"

const float WATER_F0 = 0.02;

float fresnelSchlick(float cosTheta) {
  float m = 1.0 - saturate(cosTheta);
  float m2 = m * m;
  return WATER_F0 + (1.0 - WATER_F0) * m2 * m2 * m;
}

float ggxD(float ndh, float alpha) {
  float a2 = alpha * alpha;
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

// Smith height-correlated visibility V = G / (4 ndl ndv).
float smithVisibility(float ndl, float ndv, float alpha) {
  float a2 = alpha * alpha;
  float gv = ndl * sqrt(ndv * ndv * (1.0 - a2) + a2);
  float gl = ndv * sqrt(ndl * ndl * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-7);
}

// Specular BRDF value (without the cosine).
float oceanSpecular(vec3 n, vec3 v, vec3 l, float alpha) {
  float ndl = dot(n, l);
  float ndv = dot(n, v);
  if (ndl <= 0.0 || ndv <= 0.0) return 0.0;
  vec3 h = normalize(l + v);
  return ggxD(saturate(dot(n, h)), alpha) * smithVisibility(ndl, ndv, alpha) * fresnelSchlick(dot(v, h));
}

// Diffuse (water-leaving) BRDF value (without the cosine).
vec3 oceanDiffuse(vec3 albedo, float ndl, float ndv) {
  return albedo * INV_PI * (1.0 - fresnelSchlick(ndl)) * (1.0 - fresnelSchlick(ndv));
}
