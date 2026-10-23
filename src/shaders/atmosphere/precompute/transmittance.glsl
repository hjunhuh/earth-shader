// Precompute pass 1: transmittance to the top of the atmosphere.
#include "atmosphere/functions"
layout(location = 0) out vec4 outValue;
void main() {
  outValue = vec4(ComputeTransmittanceToTopAtmosphereBoundaryTexture(ATMOSPHERE, gl_FragCoord.xy), 1.0);
}
