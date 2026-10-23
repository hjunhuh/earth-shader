// Exposure (1x1): EV100 = max(incident-light EV, highlight-protection EV),
// clamped and smoothed over time. The highlight EV keeps the ~95th
// percentile luminance (lognormal: μ + 1.645σ of log2 L) under the AgX
// shoulder (≈ 2.9 after exposure), so sunsets keep their color, while the
// incident EV keeps sunlit white clouds white instead of metering them grey.
uniform sampler2D uMeter;
uniform sampler2D uPrevious;
uniform float uMeterLod;
uniform float uBlend;        // 1 - exp(-dt / tau); 1 = instant
uniform float uEvMin;
uniform float uEvMax;
uniform float uIncidentEv;   // from the CPU illuminance model
layout(location = 0) out vec4 outValue;
void main() {
  vec3 m = textureLod(uMeter, vec2(0.5), uMeterLod).rgb;
  float prev = texelFetch(uPrevious, ivec2(0), 0).r;
  float target = uIncidentEv;
  if (m.g > 1e-6) {
    float mu = m.r / m.g;
    float sigma = sqrt(max(m.b / m.g - mu * mu, 0.0));
    float highLog2 = mu + 1.645 * sigma + log2(1000.0); // kcd/m² -> cd/m²
    // L / (1.2 · 2^EV) = 2.9  ⇒  EV = log2 L − log2(3.48)
    float highlightEv = highLog2 - log2(3.48);
    target = max(uIncidentEv, highlightEv);
  }
  target = clamp(target, uEvMin, uEvMax);
  float ev = prev <= -100.0 ? target : mix(prev, target, uBlend);
  outValue = vec4(ev, target, 0.0, 1.0);
}
