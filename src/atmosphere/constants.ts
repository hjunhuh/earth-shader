/** Precomputed wavelengths [nm] and LUT dimensions (Bruneton 2017 defaults). */
export const LAMBDA_R = 680
export const LAMBDA_G = 550
export const LAMBDA_B = 440
export const LAMBDAS = [LAMBDA_R, LAMBDA_G, LAMBDA_B] as const

export const TRANSMITTANCE_TEXTURE_WIDTH = 256
export const TRANSMITTANCE_TEXTURE_HEIGHT = 64
export const SCATTERING_TEXTURE_R_SIZE = 32
export const SCATTERING_TEXTURE_MU_SIZE = 128
export const SCATTERING_TEXTURE_MU_S_SIZE = 32
export const SCATTERING_TEXTURE_NU_SIZE = 8
export const SCATTERING_TEXTURE_WIDTH = SCATTERING_TEXTURE_NU_SIZE * SCATTERING_TEXTURE_MU_S_SIZE
export const SCATTERING_TEXTURE_HEIGHT = SCATTERING_TEXTURE_MU_SIZE
export const SCATTERING_TEXTURE_DEPTH = SCATTERING_TEXTURE_R_SIZE
// 256 (Bruneton default 64): linear interpolation across the steep twilight
// falloff overestimated sky irradiance by ~46% at -6° with 64 texels.
export const IRRADIANCE_TEXTURE_WIDTH = 256
export const IRRADIANCE_TEXTURE_HEIGHT = 16

export type Vec3 = [number, number, number]

