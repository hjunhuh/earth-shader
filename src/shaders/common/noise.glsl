// Tileable 3D noise for cloud textures. Integer hashing (PCG3D) keeps the
// results identical across GPUs and lets tests/reference/noise.ts reproduce
// them bit-for-bit in the lattice and to float precision overall.

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

// Uniform random in [0, 1)^3 for an integer lattice point (wrapped by period).
vec3 hash33(ivec3 cell, int period, uint seed) {
  uvec3 c = uvec3((cell % period + period) % period);
  uvec3 h = pcg3d(c + uvec3(seed * 1013u, seed * 7919u, seed * 104729u));
  return vec3(h >> 8u) * (1.0 / 16777216.0);
}

vec3 quintic(vec3 t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// Perlin gradient noise in [-1, 1] (approximately), periodic with `period`.
float perlinNoise(vec3 p, int period, uint seed) {
  vec3 i = floor(p);
  vec3 f = p - i;
  ivec3 c = ivec3(i);
  vec3 u = quintic(f);
  float n[8];
  for (int k = 0; k < 8; ++k) {
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    vec3 g = normalize(hash33(c + o, period, seed) * 2.0 - 1.0 + 1e-6);
    n[k] = dot(g, f - vec3(o));
  }
  float x00 = mix(n[0], n[1], u.x);
  float x10 = mix(n[2], n[3], u.x);
  float x01 = mix(n[4], n[5], u.x);
  float x11 = mix(n[6], n[7], u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z) * 1.7;
}

// Worley F1 distance (cells of size 1), periodic with `period`; ~[0, 1].
float worleyNoise(vec3 p, int period, uint seed) {
  vec3 i = floor(p);
  vec3 f = p - i;
  ivec3 c = ivec3(i);
  float d = 1e9;
  for (int z = -1; z <= 1; ++z) {
    for (int y = -1; y <= 1; ++y) {
      for (int x = -1; x <= 1; ++x) {
        ivec3 o = ivec3(x, y, z);
        vec3 r = vec3(o) + hash33(c + o, period, seed) - f;
        d = min(d, dot(r, r));
      }
    }
  }
  return sqrt(d);
}

// fBm of Perlin noise with octave frequencies 2^k (period scales with it).
float perlinFbm(vec3 p, int period, int octaves, uint seed) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  int per = period;
  vec3 q = p;
  for (int k = 0; k < 8; ++k) {
    if (k >= octaves) break;
    sum += amp * perlinNoise(q, per, seed + uint(k));
    norm += amp;
    amp *= 0.5;
    q *= 2.0;
    per *= 2;
  }
  return sum / norm;
}

// Inverted Worley fBm in [0, 1] (1 = cell centers), 3 octaves of frequency
// ratio 2 starting at `period` cells.
float worleyFbm(vec3 p, int period, uint seed) {
  float w0 = 1.0 - worleyNoise(p * float(period), period, seed);
  float w1 = 1.0 - worleyNoise(p * float(period * 2), period * 2, seed + 11u);
  float w2 = 1.0 - worleyNoise(p * float(period * 4), period * 4, seed + 23u);
  return clamp(w0 * 0.625 + w1 * 0.25 + w2 * 0.125, 0.0, 1.0);
}
