// Runtime atmosphere API (luminance in LUMINANCE_UNIT = kcd/m²).
// Positions are in km, relative to the planet center in shading space.
#include "atmosphere/functions"

uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler2D irradiance_texture;

const float METER_TO_KM = 0.001;

Luminance3 GetSolarLuminance() {
  return ATMOSPHERE.solar_irradiance /
      (PI * ATMOSPHERE.sun_angular_radius * ATMOSPHERE.sun_angular_radius) *
      SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
}

Luminance3 GetSkyLuminance(
    Position camera, Direction view_ray, Length shadow_length,
    Direction sun_direction, out DimensionlessSpectrum transmittance) {
  return GetSkyRadiance(ATMOSPHERE, transmittance_texture,
      scattering_texture, single_mie_scattering_texture,
      camera, view_ray, shadow_length, sun_direction, transmittance) *
      SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
}

// GetSkyRadianceToPoint with the horizon fix from Bruneton PR #32: for rays
// that do not hit the ground, mu is kept slightly above the horizon so the
// difference of two scattering lookups does not produce a bright stripe.
RadianceSpectrum GetSkyRadianceToPointFixed(
    Position camera, Position point, Length shadow_length,
    Direction sun_direction, out DimensionlessSpectrum transmittance) {
  Direction view_ray = normalize(point - camera);
  Length r = length(camera);
  Length rmu = dot(camera, view_ray);
  Length distance_to_top_atmosphere_boundary = -rmu -
      sqrt(max(rmu * rmu - r * r + ATMOSPHERE.top_radius * ATMOSPHERE.top_radius, 0.0));
  if (distance_to_top_atmosphere_boundary > 0.0) {
    camera = camera + view_ray * distance_to_top_atmosphere_boundary;
    r = ATMOSPHERE.top_radius;
    rmu += distance_to_top_atmosphere_boundary;
  }
  Number mu = rmu / r;
  Number mu_s = dot(camera, sun_direction) / r;
  Number nu = dot(view_ray, sun_direction);
  Length d = length(point - camera);
  bool ray_r_mu_intersects_ground = RayIntersectsGround(ATMOSPHERE, r, mu);
  if (!ray_r_mu_intersects_ground) {
    Number mu_horizon = -SafeSqrt(1.0 - (ATMOSPHERE.bottom_radius / r) * (ATMOSPHERE.bottom_radius / r));
    mu = max(mu, mu_horizon + 0.004);
  }
  transmittance = GetTransmittance(ATMOSPHERE, transmittance_texture,
      r, mu, d, ray_r_mu_intersects_ground);
  IrradianceSpectrum single_mie_scattering;
  IrradianceSpectrum scattering = GetCombinedScattering(
      ATMOSPHERE, scattering_texture, single_mie_scattering_texture,
      r, mu, mu_s, nu, ray_r_mu_intersects_ground, single_mie_scattering);
  d = max(d - shadow_length, 0.0);
  Length r_p = ClampRadius(ATMOSPHERE, sqrt(d * d + 2.0 * r * mu * d + r * r));
  Number mu_p = (r * mu + d) / r_p;
  Number mu_s_p = (r * mu_s + d * nu) / r_p;
  IrradianceSpectrum single_mie_scattering_p;
  IrradianceSpectrum scattering_p = GetCombinedScattering(
      ATMOSPHERE, scattering_texture, single_mie_scattering_texture,
      r_p, mu_p, mu_s_p, nu, ray_r_mu_intersects_ground, single_mie_scattering_p);
  DimensionlessSpectrum shadow_transmittance = transmittance;
  if (shadow_length > 0.0) {
    shadow_transmittance = GetTransmittance(ATMOSPHERE, transmittance_texture,
        r, mu, d, ray_r_mu_intersects_ground);
  }
  scattering = max(scattering - shadow_transmittance * scattering_p, vec3(0.0));
  single_mie_scattering = max(single_mie_scattering - shadow_transmittance * single_mie_scattering_p, vec3(0.0));
  single_mie_scattering = single_mie_scattering * smoothstep(Number(0.0), Number(0.01), mu_s);
  return scattering * RayleighPhaseFunction(nu) + single_mie_scattering *
      MiePhaseFunction(ATMOSPHERE.mie_phase_function_g, nu);
}

Luminance3 GetSkyLuminanceToPoint(
    Position camera, Position point, Length shadow_length,
    Direction sun_direction, out DimensionlessSpectrum transmittance) {
  return GetSkyRadianceToPointFixed(camera, point, shadow_length, sun_direction, transmittance) *
      SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
}

Illuminance3 GetSunAndSkyIlluminance(
    Position p, Direction normal, Direction sun_direction,
    out IrradianceSpectrum sky_irradiance) {
  IrradianceSpectrum sun_irradiance = GetSunAndSkyIrradiance(
      ATMOSPHERE, transmittance_texture, irradiance_texture, p, normal,
      sun_direction, sky_irradiance);
  sky_irradiance *= SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
  return sun_irradiance * SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
}

// Sun illuminance on a surface facing the sun (no cosine), and horizontal
// sky illuminance, at a point (for volumetric lighting).
Illuminance3 GetSunAndSkyScalarIlluminance(
    Position p, Direction sun_direction, out Illuminance3 sky_illuminance) {
  Length r = length(p);
  Number mu_s = dot(p, sun_direction) / r;
  sky_illuminance = GetIrradiance(ATMOSPHERE, irradiance_texture, r, mu_s) *
      SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
  return ATMOSPHERE.solar_irradiance *
      GetTransmittanceToSun(ATMOSPHERE, transmittance_texture, r, mu_s) *
      SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
}

// Transmittance between two points (km), both inside the atmosphere.
DimensionlessSpectrum GetTransmittanceBetween(Position a, Position b) {
  Direction v = normalize(b - a);
  Length r = length(a);
  Number mu = dot(a, v) / r;
  Length d = length(b - a);
  return GetTransmittance(ATMOSPHERE, transmittance_texture,
      ClampRadius(ATMOSPHERE, r), mu, d, RayIntersectsGround(ATMOSPHERE, ClampRadius(ATMOSPHERE, r), mu));
}

// Sky luminance along a camera ray whose ground intersection is decided by
// the caller (the ray-traced ocean). Forcing the table half and clamping mu
// to the matching side of the horizon keeps sky/ocean consistent at the limb.
// For ground rays this is the in-scattering between camera and ocean
// (aerial perspective); `transmittance` is the camera→ocean transmittance.
Luminance3 GetSkyLuminanceClassified(
    Position camera, Direction view_ray, Length shadow_length,
    Direction sun_direction, bool hits_ground, out DimensionlessSpectrum transmittance) {
  Length r = length(camera);
  Length rmu = dot(camera, view_ray);
  Area disc = rmu * rmu - r * r + ATMOSPHERE.top_radius * ATMOSPHERE.top_radius;
  if (r > ATMOSPHERE.top_radius) {
    Length d_top = -rmu - sqrt(max(disc, 0.0));
    if (disc < 0.0 || d_top <= 0.0) {
      transmittance = DimensionlessSpectrum(1.0);
      return Luminance3(0.0);
    }
    camera = camera + view_ray * d_top;
    r = ATMOSPHERE.top_radius;
    rmu += d_top;
  }
  Number mu = rmu / r;
  Number mu_horizon = -SafeSqrt(1.0 - (ATMOSPHERE.bottom_radius / r) * (ATMOSPHERE.bottom_radius / r));
  mu = hits_ground ? min(mu, mu_horizon) : max(mu, mu_horizon);
  Number mu_s = dot(camera, sun_direction) / r;
  Number nu = dot(view_ray, sun_direction);
  if (hits_ground) {
    Length d = DistanceToBottomAtmosphereBoundary(ATMOSPHERE, r, mu);
    transmittance = GetTransmittance(ATMOSPHERE, transmittance_texture, r, mu, d, true);
  } else {
    transmittance = GetTransmittanceToTopAtmosphereBoundary(ATMOSPHERE, transmittance_texture, r, mu);
  }
  IrradianceSpectrum single_mie_scattering;
  IrradianceSpectrum scattering;
  if (shadow_length <= 0.0) {
    scattering = GetCombinedScattering(ATMOSPHERE, scattering_texture, single_mie_scattering_texture,
        r, mu, mu_s, nu, hits_ground, single_mie_scattering);
  } else {
    Length d = shadow_length;
    Length r_p = ClampRadius(ATMOSPHERE, sqrt(d * d + 2.0 * r * mu * d + r * r));
    Number mu_p = (r * mu + d) / r_p;
    Number mu_s_p = (r * mu_s + d * nu) / r_p;
    scattering = GetCombinedScattering(ATMOSPHERE, scattering_texture, single_mie_scattering_texture,
        r_p, mu_p, mu_s_p, nu, hits_ground, single_mie_scattering);
    DimensionlessSpectrum shadow_transmittance =
        GetTransmittance(ATMOSPHERE, transmittance_texture, r, mu, shadow_length, hits_ground);
    scattering *= shadow_transmittance;
    single_mie_scattering *= shadow_transmittance;
  }
  single_mie_scattering *= smoothstep(Number(-0.01), Number(0.01), mu_s);
  return (scattering * RayleighPhaseFunction(nu) +
      single_mie_scattering * MiePhaseFunction(ATMOSPHERE.mie_phase_function_g, nu)) *
      SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
}
