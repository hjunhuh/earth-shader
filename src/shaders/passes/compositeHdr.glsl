// HDR composite: background (ocean + sky) under premultiplied clouds.
uniform sampler2D uBackground;
uniform sampler2D uClouds;
uniform int uCloudsEnabled;
uniform vec2 uSize;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 bg = texelFetch(uBackground, ivec2(gl_FragCoord.xy), 0).rgb;
  if (uCloudsEnabled == 0) {
    outColor = vec4(bg, 1.0);
    return;
  }
  vec4 c = texture(uClouds, uv);
  outColor = vec4(bg * (1.0 - c.a) + c.rgb, 1.0);
}
