// Bloom upsample: 3x3 tent of the coarser level added to this level.
uniform sampler2D uCoarse;
uniform sampler2D uFine;
uniform vec2 uCoarseTexel;
uniform vec2 uTargetSize;
layout(location = 0) out vec4 outValue;
void main() {
  vec2 uv = gl_FragCoord.xy / uTargetSize;
  vec2 t = uCoarseTexel;
  vec3 s = texture(uCoarse, uv).rgb * 4.0;
  s += (texture(uCoarse, uv + vec2(-t.x, 0.0)).rgb + texture(uCoarse, uv + vec2(t.x, 0.0)).rgb +
        texture(uCoarse, uv + vec2(0.0, -t.y)).rgb + texture(uCoarse, uv + vec2(0.0, t.y)).rgb) * 2.0;
  s += texture(uCoarse, uv + vec2(-t.x, -t.y)).rgb + texture(uCoarse, uv + vec2(t.x, -t.y)).rgb +
       texture(uCoarse, uv + vec2(-t.x, t.y)).rgb + texture(uCoarse, uv + vec2(t.x, t.y)).rgb;
  outValue = vec4(s / 16.0 + texture(uFine, uv).rgb, 1.0);
}
