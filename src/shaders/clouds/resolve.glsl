// Temporal reconstruction of the cloud buffer (report §4.1). The low-res
// pass rendered one full-res pixel per k×k block this frame (uSampleOffset);
// that pixel takes the fresh sample, every other pixel reprojects its
// history through the cloud's mean distance and clips it to the current
// neighborhood (variance clipping, μ ± γσ). With k = 1 this is plain TAA.
#include "common/math"
#include "common/camera"

uniform sampler2D uCurrent;       // low-res: premultiplied luminance + alpha
uniform sampler2D uCurrentDepth;  // low-res: mean cloud distance (-1 = none)
uniform sampler2D uHistory;       // full-res history color
uniform sampler2D uHistoryDepth;  // full-res history: (distance, accumulated sample count)
uniform mat3 uPrevShadingToView;  // previous frame: shading direction -> view
uniform vec3 uCameraDelta;        // current - previous camera (shading space) [m]
uniform int uUpscale;             // k
uniform vec2 uSampleOffset;       // this frame's sample position in the block (pixels)
uniform float uBlend;             // weight of the current sample (k = 1)
uniform float uFreshBlend;        // weight of a fresh sample over its history (k > 1)
uniform float uGamma;             // variance clipping width
uniform int uHistoryValid;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;

void main() {
  ivec2 hp = ivec2(gl_FragCoord.xy);
  ivec2 lowSize = textureSize(uCurrent, 0);
  ivec2 lp = min(hp / uUpscale, lowSize - 1);

  vec4 m1 = vec4(0.0);
  vec4 m2 = vec4(0.0);
  float nearestDepth = 1e20;
  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      ivec2 q = clamp(lp + ivec2(dx, dy), ivec2(0), lowSize - 1);
      vec4 c = texelFetch(uCurrent, q, 0);
      m1 += c;
      m2 += c * c;
      float d = texelFetch(uCurrentDepth, q, 0).r;
      if (d > 0.0) nearestDepth = min(nearestDepth, d);
    }
  }
  m1 /= 9.0;
  vec4 sigma = sqrt(max(m2 / 9.0 - m1 * m1, vec4(0.0)));

  vec4 current = texelFetch(uCurrent, lp, 0);
  float currentDepth = texelFetch(uCurrentDepth, lp, 0).r;
  bool fresh = uUpscale > 1 && all(equal(hp - lp * uUpscale, ivec2(floor(uSampleOffset))));

  // Reproject this pixel through the nearest cloud distance in the neighborhood
  // (closest-fragment rule); empty sky reprojects by direction only.
  vec2 ndc = (vec2(hp) + 0.5) / uResolution * 2.0 - 1.0;
  vec3 dir = normalize(uViewToShading * vec3(ndc * uTanHalfFov, -1.0));
  vec3 v = nearestDepth < 1e19
    ? uPrevShadingToView * (dir * nearestDepth + uCameraDelta)
    : uPrevShadingToView * dir;
  vec2 prevNdc = v.xy / (-v.z * uTanHalfFov);
  vec2 prevUv = prevNdc * 0.5 + 0.5;
  bool onScreen = v.z < 0.0 && all(greaterThanEqual(prevUv, vec2(0.0))) && all(lessThanEqual(prevUv, vec2(1.0)));

  vec4 result;
  float depth;
  float count = 0.0;
  if (uHistoryValid == 0 || !onScreen) {
    // No usable history: spatial upsample of the current frame.
    result = texture(uCurrent, (vec2(hp) + 0.5) / (vec2(lowSize) * float(uUpscale)));
    depth = currentDepth;
    count = fresh || uUpscale == 1 ? 1.0 : 0.0;
  } else {
    vec4 history = clamp(texture(uHistory, prevUv), m1 - uGamma * sigma, m1 + uGamma * sigma);
    vec2 h = texture(uHistoryDepth, prevUv).rg;
    // Motion > 1.5 px since the last frame: restart accumulation so the next
    // fresh sample replaces the (reprojected, clipped) history outright.
    float motion = length(prevUv * uResolution - (vec2(hp) + 0.5));
    float n = motion > 1.5 ? 0.0 : h.g;
    if (uUpscale == 1 || fresh) {
      // Running average of fresh samples, floored so it keeps tracking change.
      float alpha = max(1.0 / (n + 1.0), uUpscale == 1 ? uBlend : uFreshBlend);
      result = mix(history, current, alpha);
      depth = currentDepth;
      count = min(n + 1.0, 16.0);
    } else {
      result = history;
      depth = h.r;
      count = n;
    }
  }
  outColor = result;
  outDepth = vec4(depth, count, 0.0, 1.0);
}
