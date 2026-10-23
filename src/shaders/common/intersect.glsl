// Ray from a camera-relative origin (0) against a sphere centered at the
// planet center, with b = dot(cameraPos, dir) and the CPU-precomputed
// c = (|o| - R)(|o| + R). Roots of t² + 2bt + c = 0 in ascending order;
// returns vec2(-1) on a miss. Mirrors raySphereStable() in src/geo/intersect.ts.
vec2 raySphereStable(float b, float c) {
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  float q = b > 0.0 ? -b - s : -b + s;
  if (q == 0.0) return vec2(0.0);
  float t0 = q;
  float t1 = c / q;
  return t0 < t1 ? vec2(t0, t1) : vec2(t1, t0);
}

// Same for four concentric spheres at once (cloud shells).
// Returns near roots in .xyzw of `nearRoots`, far roots in `farRoots`;
// misses produce -1 in both.
void raySphereStable4(float b, vec4 c, out vec4 nearRoots, out vec4 farRoots) {
  vec4 disc = b * b - c;
  vec4 s = sqrt(max(disc, 0.0));
  vec4 q = b > 0.0 ? -b - s : -b + s;
  vec4 t0 = q;
  vec4 t1 = c / q;
  nearRoots = min(t0, t1);
  farRoots = max(t0, t1);
  bvec4 miss = lessThan(disc, vec4(0.0));
  nearRoots = mix(nearRoots, vec4(-1.0), vec4(miss));
  farRoots = mix(farRoots, vec4(-1.0), vec4(miss));
}

// Generic ray–sphere for an arbitrary origin (used where precision is not critical).
vec2 raySphere(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  float c = dot(origin, origin) - radius * radius;
  return raySphereStable(b, c);
}
