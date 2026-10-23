// Cloud ray marching (report §3) through the spherical cloud shell in
// shading space. Writes premultiplied cloud luminance (kcd/m², with aerial
// perspective) + alpha, and the transmittance-weighted mean distance.
#include "common/math"
#include "common/camera"
#include "atmosphere/runtime"
#include "clouds/density"
#include "clouds/lighting"
#include "clouds/sunShadow"
#include "clouds/lightMarch"
#ifndef LIGHT_STEPS
#define LIGHT_STEPS 4
#endif

#ifndef MAX_PRIMARY_STEPS
#define MAX_PRIMARY_STEPS 128
#endif

uniform vec3 uSunDirection;     // shading space, unit
uniform vec4 uGroupC;           // c-terms of spheres a + (min0, max0, min1, max1)
uniform float uStepScale;       // step ∝ distance
uniform float uMinStep;
uniform float uMaxStep;
uniform float uMinTransmittance;
uniform float uWeatherTexel;    // weather texel length [m]
uniform float uFrame;
uniform float uJitterAmount;    // 0 = fixed sample positions
uniform vec2 uFullResolution;   // resolved (full) cloud buffer size
uniform vec2 uSampleOffset;     // this frame's sample position in the k×k block (pixels)
uniform int uUpscale;           // k

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;

const int MIN_SAMPLES_PER_SEGMENT = 6;

// Base height of the layer a sample belongs to (for the column optical depth).
float columnBaseHeight(float h) {
  return h >= uOdHeights.w ? uOdHeights.w : uOdHeights.y;
}

// Ray segments inside the spherical shell [Ra, Rb] (inner/outer roots given),
// clipped to [0, tMax]. Up to two segments (entering and leaving the shell).
void shellSegments(vec2 inner, vec2 outer, float camH, float hMin, float hMax, float tMax,
                   inout vec2 segs[4], inout int count) {
  vec2 a = vec2(-1.0);
  vec2 b = vec2(-1.0);
  if (camH < hMin) {
    a = vec2(inner.y, outer.y);
  } else if (camH <= hMax) {
    if (inner.x > 0.0) {
      a = vec2(0.0, inner.x);
      b = vec2(inner.y, outer.y);
    } else {
      a = vec2(0.0, outer.y);
    }
  } else if (outer.y > 0.0) {
    if (inner.x > 0.0) {
      a = vec2(max(outer.x, 0.0), inner.x);
      b = vec2(inner.y, outer.y);
    } else {
      a = vec2(max(outer.x, 0.0), outer.y);
    }
  }
  if (a.y > a.x && a.x < tMax && count < 4) {
    segs[count++] = vec2(max(a.x, 0.0), min(a.y, tMax));
  }
  if (b.y > b.x && b.x < tMax && count < 4) {
    segs[count++] = vec2(max(b.x, 0.0), min(b.y, tMax));
  }
}

void main() {
  // Each low-res pixel samples exactly one full-res pixel of its k×k block.
  vec2 hi = floor(gl_FragCoord.xy) * float(uUpscale) + uSampleOffset;
  vec2 ndc = hi / uFullResolution * 2.0 - 1.0;
  vec3 dir = cameraRayDirection(ndc);
  float b = dot(uCameraShading, dir);
  vec4 nearR;
  vec4 farR;
  raySphereStable4(b, uGroupC, nearR, farR);
  float tOcean = oceanDistance(dir);
  float tMax = tOcean > 0.0 ? tOcean : 1e12;
  float h = uCameraHeight;
  outColor = vec4(0.0);
  outDepth = vec4(-1.0);
  // Below the lowest cloud base, rays that hit the ocean see no clouds.
  vec2 segs[4];
  int count = 0;
  shellSegments(vec2(nearR.x, farR.x), vec2(nearR.y, farR.y), h, uGroups.x, uGroups.y, tMax, segs, count);
  if (uGroupCount > 1) {
    shellSegments(vec2(nearR.z, farR.z), vec2(nearR.w, farR.w), h, uGroups.z, uGroups.w, tMax, segs, count);
  }
  if (count == 0) return;
  // Sort segments front to back (≤ 4, insertion sort).
  for (int i = 1; i < 4; ++i) {
    if (i >= count) break;
    vec2 key = segs[i];
    int j = i - 1;
    while (j >= 0 && segs[j].x > key.x) {
      segs[j + 1] = segs[j];
      --j;
    }
    segs[j + 1] = key;
  }

  float jitter = interleavedGradientNoise(hi + mod(uFrame, 64.0) * vec2(5.588, 3.191));
  jitter = mix(0.5, jitter, uJitterAmount);
  float T = 1.0;
  vec3 L = vec3(0.0);
  float depthSum = 0.0;
  float weightSum = 0.0;
  float cosTheta = dot(dir, uSunDirection);
  int budget = MAX_PRIMARY_STEPS;
  for (int s = 0; s < 4; ++s) {
    if (s >= count || T < uMinTransmittance) break;
    float t0 = segs[s].x;
    float t1 = segs[s].y;
    float len = t1 - t0;
    float tMid = 0.5 * (t0 + t1);
    float footprint = uPixelAngle * max(tMid, 1.0);
    float lod = log2(max(1.0, footprint / uWeatherTexel));
    // Far away the 3D structure is sub-pixel: steps may grow to half a
    // (mip-level) weather texel; every crossing gets ≥ MIN_SAMPLES samples.
    float maxStep = max(uMaxStep, 0.5 * uWeatherTexel * exp2(lod));
    float ds = clamp(uStepScale * tMid, uMinStep, maxStep);
    ds = min(ds, len / float(MIN_SAMPLES_PER_SEGMENT));
    int n = int(ceil(len / ds));
    n = min(n, max(budget, MIN_SAMPLES_PER_SEGMENT));
    budget -= n;
    ds = len / float(n);
    bool done = false;
    for (int i = 0; i < MAX_PRIMARY_STEPS; ++i) {
      if (i >= n || done) break;
      // Fixed step boundaries; jitter only the density probe inside the step.
      float ta = t0 + float(i) * ds;
      float tj = ta + jitter * ds;
      vec3 pj = uCameraShading + dir * tj;
      float rj = length(pj);
      float fp = uPixelAngle * max(tj, 1.0);
      vec4 probe4 = cloudExtinction3D(pj / rj, rj - EARTH_RADIUS, dir * tj, fp, lod, true);
      float probe = dot(probe4, vec4(1.0));
      if (probe <= 1e-8) continue;
      // Optically thick steps are subdivided (≤ 0.35 optical depth each) so the
      // cloud top, where reflected light originates, is resolved even with the
      // large steps used from orbit (thick media terminate within a few τ).
      int sub = probe * ds > 0.35 ? min(16, int(ceil(probe * ds / 0.35))) : 1;
      float dsub = ds / float(sub);
      for (int k = 0; k < 16; ++k) {
        if (k >= sub) break;
        float tk = ta + float(k) * dsub;
        vec4 sigma4 = probe4;
        if (sub > 1) {
          float tkj = tk + jitter * dsub;
          vec3 pk = uCameraShading + dir * tkj;
          float rk = length(pk);
          sigma4 = cloudExtinction3D(pk / rk, rk - EARTH_RADIUS, dir * tkj, fp, lod, true);
        }
        float sigma = dot(sigma4, vec4(1.0));
        if (sigma <= 1e-8) continue;
        float stepT = exp(-sigma * dsub);
        // Light the absorption-weighted mean point of the (sub)step.
        float sBar = sigma * dsub > 1e-3 ? 1.0 / sigma - dsub * stepT / (1.0 - stepT) : 0.5 * dsub;
        float tl = tk + clamp(sBar, 0.0, dsub);
        vec3 pl = uCameraShading + dir * tl;
        float rl = length(pl);
        vec3 nl = pl / rl;
        float hl = rl - EARTH_RADIUS;
        // Self-shadow: near light march + far remainder from the baked cubemap.
        vec2 nearOd = nearSunOpticalDepth(pl, uSunDirection, LIGHT_STEPS, fp, lod);
        vec3 pFar = pl + uSunDirection * nearOd.y;
        float rFar = length(pFar);
        float odSun = nearOd.x + sunOpticalDepthAt(pFar / rFar, rFar - EARTH_RADIUS);
        float odColumn = sunOpticalDepthAt(nl, columnBaseHeight(hl));
        vec4 f = heightFractions(hl);
        float hf = dot(saturate(f), sigma4) / sigma;
        vec3 skyI;
        vec3 sunI = GetSunAndSkyScalarIlluminance(pl * METER_TO_KM, uSunDirection, skyI);
        vec3 J = cloudSourceFunction(sunI, skyI, cosTheta, odSun, odColumn, hf);
#ifdef POWDER
        J *= 1.0 - 0.5 * exp(-150.0 * sigma);
#endif
        float absorbed = T * (1.0 - stepT);
        L += J * absorbed;
        depthSum += absorbed * tl;
        weightSum += absorbed;
        T *= stepT;
        if (T < uMinTransmittance) {
          T = 0.0;
          done = true;
          break;
        }
      }
    }
  }
  float alpha = 1.0 - T;
  if (alpha <= 1e-5) return;
  float meanDistance = depthSum / max(weightSum, 1e-8);
  vec3 cameraKm = uCameraShading * METER_TO_KM;
  vec3 pointKm = (uCameraShading + dir * meanDistance) * METER_TO_KM;
  vec3 atmT;
  vec3 inscatter = GetSkyLuminanceToPoint(cameraKm, pointKm, 0.0, uSunDirection, atmT);
  L = L * atmT + inscatter * alpha;
  outColor = vec4(L, alpha);
  outDepth = vec4(meanDistance, 0.0, 0.0, 1.0);
}
