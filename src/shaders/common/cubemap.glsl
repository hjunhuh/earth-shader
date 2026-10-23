// Cube face conventions follow the GL major-axis table so that rendering a
// face with gl_FragCoord-derived (s, t) and sampling with texture(cube, dir)
// agree without any flips. Faces: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z.

// sc, tc in [-1, 1] -> unnormalized direction on the unit cube.
vec3 cubeFaceDirection(int face, vec2 sct) {
  float sc = sct.x;
  float tc = sct.y;
  if (face == 0) return vec3(1.0, -tc, -sc);
  if (face == 1) return vec3(-1.0, -tc, sc);
  if (face == 2) return vec3(sc, 1.0, tc);
  if (face == 3) return vec3(sc, -1.0, -tc);
  if (face == 4) return vec3(sc, -tc, 1.0);
  return vec3(-sc, -tc, -1.0);
}

// Equi-angular cube mapping: texel coordinate u' = (4/pi) atan(u) gives
// near-uniform texel solid angles. Generation uses the inverse (tan), lookup
// warps the direction so hardware seamless filtering still applies.
const float CUBE_PI_4 = 0.78539816339;

vec2 equiAngularToCube(vec2 w) {
  return tan(w * CUBE_PI_4);
}

vec2 cubeToEquiAngular(vec2 u) {
  return atan(u) / CUBE_PI_4;
}

// Direction for an equi-angular face texel (w in [-1, 1]).
vec3 equiAngularFaceDirection(int face, vec2 w) {
  return normalize(cubeFaceDirection(face, equiAngularToCube(w)));
}

// Warps a direction so that texture(cube, warped) samples the equi-angular
// texel layout produced by equiAngularFaceDirection.
vec3 warpEquiAngular(vec3 dir) {
  vec3 a = abs(dir);
  if (a.x >= a.y && a.x >= a.z) {
    vec2 u = dir.yz / a.x;
    return vec3(sign(dir.x), cubeToEquiAngular(u));
  } else if (a.y >= a.z) {
    vec2 u = dir.xz / a.y;
    vec2 w = cubeToEquiAngular(u);
    return vec3(w.x, sign(dir.y), w.y);
  } else {
    vec2 u = dir.xy / a.z;
    vec2 w = cubeToEquiAngular(u);
    return vec3(w, sign(dir.z));
  }
}
