// Background pass: ray-traced ocean sphere + sky with precomputed
// atmospheric scattering. Writes linear HDR luminance in kcd/m²
// (LUMINANCE_UNIT) and the ray distance to the ocean in meters (-1 = sky).
#include "common/math"
#include "common/camera"
#include "atmosphere/runtime"
#include "ocean"
#include "common/stars"
#ifdef CLOUD_SHADOWS
#include "clouds/lightMarch"
#ifndef OCEAN_SHADOW_STEPS
#define OCEAN_SHADOW_STEPS 8
#endif
uniform float uShadowWeatherTexel;
#endif

uniform vec3 uSunDirection;     // shading space, unit
#ifdef LIGHT_SHAFTS
uniform sampler2D uShadowLength; // shadowed fraction of the first uShaftDistance, quarter resolution
uniform float uShaftDistance;    // [m]
#endif
uniform vec3 uOceanAlbedo;      // linear water-leaving albedo
uniform float uOceanRoughness;  // GGX alpha

#ifdef CLOUD_REFLECTIONS
// Resolved clouds of this frame: the sea mirrors them (screen-space lookup of
// the reflected direction; clouds are far away, so direction-only).
uniform sampler2D uCloudsResolved;
#endif

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDistance;

// Half-float safe ceiling for the sun disk (kcd/m²).
const float MAX_LUMINANCE = 60000.0;

vec3 sunDisk(vec3 dir, vec3 transmittance) {
  float cosAngle = dot(dir, uSunDirection);
  float cosRadius = cos(ATMOSPHERE.sun_angular_radius);
  if (cosAngle < cosRadius) return vec3(0.0);
  // Limb darkening I(μ) = 1 - u(1 - μ), u = 0.6, normalized to unit mean.
  float sinAngle = sqrt(max(0.0, 1.0 - cosAngle * cosAngle));
  float x = sinAngle / sin(ATMOSPHERE.sun_angular_radius);
  float muDisk = sqrt(max(0.0, 1.0 - x * x));
  float limb = (1.0 - 0.6 * (1.0 - muDisk)) / (1.0 - 0.6 / 3.0);
  return GetSolarLuminance() * transmittance * limb;
}

// Shades one camera ray (sky or ocean). Returns radiance; t = ocean distance (-1 sky).
vec3 shadeRay(vec3 dir, float shadowLength, out float tOut) {
  vec3 cameraKm = uCameraShading * METER_TO_KM;
  float t = oceanDistance(dir);
  tOut = t;
  vec3 transmittance;
  if (t < 0.0) {
    vec3 sky = GetSkyLuminanceClassified(cameraKm, dir, shadowLength, uSunDirection, false, transmittance);
    sky += sunDisk(dir, transmittance);
    // Stars (direction in ECEF: undo the shading-space z scale).
    vec3 dirEcef = normalize(vec3(dir.xy, dir.z / 1.0033640898209764));
    sky += starField(dirEcef, uPixelAngle) * transmittance;
    return min(sky, vec3(MAX_LUMINANCE));
  }
  // Ocean rays: Bruneton's shadow_length must stay shorter than the ray.
  shadowLength = min(shadowLength, 0.95 * t * METER_TO_KM);

  // Ocean point on the sphere (exactly at the atmosphere bottom).
  vec3 n = normalize(uCameraShading + dir * t);
  vec3 pKm = n * ATMOSPHERE.bottom_radius;
  vec3 v = -dir;
  vec3 skyIlluminance;
  vec3 sunIlluminance = GetSunAndSkyIlluminance(pKm, n, uSunDirection, skyIlluminance);
  float ndl = max(dot(n, uSunDirection), 0.0);
  float ndv = max(dot(n, v), 1e-4);
#ifdef CLOUD_SHADOWS
  // Cloud shadow: march the cloud density toward the sun from this ocean
  // point (weather and noise LOD follow the pixel footprint).
  float shadowFootprint = uPixelAngle * t;
  float shadowLod = log2(max(1.0, shadowFootprint / uShadowWeatherTexel));
  sunIlluminance *= exp(-surfaceSunOpticalDepth(n, uSunDirection, OCEAN_SHADOW_STEPS, shadowFootprint, shadowLod));
#endif
  // Sun: specular glint + water-leaving diffuse (sunIlluminance includes cos).
  vec3 radiance = sunIlluminance * (oceanSpecular(n, v, uSunDirection, uOceanRoughness) + oceanDiffuse(uOceanAlbedo, ndl, ndv));
  // Sky: diffuse from the (hemispherical) sky illuminance, mirror reflection of the sky.
  radiance += skyIlluminance * oceanDiffuse(uOceanAlbedo, 0.7, ndv);
  vec3 r = reflect(dir, n);
  vec3 skyT;
  vec3 skyReflected = GetSkyLuminanceClassified(pKm + n * 0.001, r, 0.0, uSunDirection, false, skyT);
#ifdef CLOUD_REFLECTIONS
  vec3 rv = uShadingToView * r;
  // Off-screen reflections reuse the nearest on-screen clouds (edge clamp),
  // so the mirrored cloud deck continues smoothly; directions behind the
  // camera fade out (steep views, where Fresnel is small anyway).
  float front = smoothstep(0.0, 0.15, -rv.z / length(rv));
  if (front > 0.0) {
    vec2 rUv = clamp(rv.xy / (-rv.z * uTanHalfFov) * 0.5 + 0.5, vec2(0.002), vec2(0.998));
    vec4 c = texture(uCloudsResolved, rUv);
    skyReflected = mix(skyReflected, skyReflected * (1.0 - c.a) + c.rgb, front);
  }
#endif
  radiance += skyReflected * fresnelSchlick(ndv);
  // Aerial perspective between camera and ocean.
  vec3 inscatter = GetSkyLuminanceClassified(cameraKm, dir, shadowLength, uSunDirection, true, transmittance);
  radiance = radiance * transmittance + inscatter;
  return min(radiance, vec3(MAX_LUMINANCE));
}

void main() {
  vec2 ndc = fragNdc(gl_FragCoord.xy);
  vec3 dir = cameraRayDirection(ndc);
#ifdef LIGHT_SHAFTS
  float tCenter = oceanDistance(dir);
  float shaftEnd = tCenter > 0.0 ? min(tCenter, uShaftDistance) : uShaftDistance;
  float shadowLength = texture(uShadowLength, gl_FragCoord.xy / uResolution).r * shaftEnd * METER_TO_KM;
#else
  float shadowLength = 0.0;
#endif
  // Horizon anti-aliasing: if the four sub-pixel rays disagree on sky vs
  // ocean, shade all four and average (only the pixels on the horizon).
  vec2 px = 1.0 / uResolution;
  vec3 d0 = cameraRayDirection(ndc + vec2(-0.5, -0.5) * px);
  vec3 d1 = cameraRayDirection(ndc + vec2(0.5, -0.5) * px);
  vec3 d2 = cameraRayDirection(ndc + vec2(-0.5, 0.5) * px);
  vec3 d3 = cameraRayDirection(ndc + vec2(0.5, 0.5) * px);
  float h0 = step(0.0, oceanDistance(d0));
  float h1 = step(0.0, oceanDistance(d1));
  float h2 = step(0.0, oceanDistance(d2));
  float h3 = step(0.0, oceanDistance(d3));
  float hits = h0 + h1 + h2 + h3;
  float t;
  vec3 radiance;
  if (hits == 0.0 || hits == 4.0) {
    radiance = shadeRay(dir, shadowLength, t);
  } else {
    float ti;
    radiance = 0.25 * (shadeRay(d0, shadowLength, ti) + shadeRay(d1, shadowLength, ti) +
                       shadeRay(d2, shadowLength, ti) + shadeRay(d3, shadowLength, ti));
    t = oceanDistance(dir);
  }
  outColor = vec4(radiance, 1.0);
  outDistance = vec4(t);
}
