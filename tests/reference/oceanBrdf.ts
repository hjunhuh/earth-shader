/** TS twin of src/shaders/ocean.glsl. */
export const WATER_F0 = 0.02

export function fresnelSchlick(cosTheta: number): number {
  const m = 1 - Math.min(1, Math.max(0, cosTheta))
  return WATER_F0 + (1 - WATER_F0) * m ** 5
}

export function ggxD(ndh: number, alpha: number): number {
  const a2 = alpha * alpha
  const d = ndh * ndh * (a2 - 1) + 1
  return a2 / (Math.PI * d * d)
}

export function smithVisibility(ndl: number, ndv: number, alpha: number): number {
  const a2 = alpha * alpha
  const gv = ndl * Math.sqrt(ndv * ndv * (1 - a2) + a2)
  const gl = ndv * Math.sqrt(ndl * ndl * (1 - a2) + a2)
  return 0.5 / Math.max(gv + gl, 1e-7)
}

type V = [number, number, number]
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const normalize = (a: V): V => {
  const l = Math.hypot(...a)
  return [a[0] / l, a[1] / l, a[2] / l]
}

export function oceanSpecular(n: V, v: V, l: V, alpha: number): number {
  const ndl = dot(n, l)
  const ndv = dot(n, v)
  if (ndl <= 0 || ndv <= 0) return 0
  const h = normalize([l[0] + v[0], l[1] + v[1], l[2] + v[2]])
  return ggxD(Math.min(1, Math.max(0, dot(n, h))), alpha) * smithVisibility(ndl, ndv, alpha) * fresnelSchlick(dot(v, h))
}

export function oceanDiffuse(albedo: number, ndl: number, ndv: number): number {
  return (albedo / Math.PI) * (1 - fresnelSchlick(ndl)) * (1 - fresnelSchlick(ndv))
}

/** Directional-hemispherical albedo for incidence cosine mu0 (numerical). */
export function directionalAlbedo(mu0: number, albedo: number, alpha: number, n = 400): number {
  const normal: V = [0, 0, 1]
  const l: V = [Math.sqrt(1 - mu0 * mu0), 0, mu0]
  let sum = 0
  for (let i = 0; i < n; ++i) {
    const cosT = (i + 0.5) / n
    const sinT = Math.sqrt(1 - cosT * cosT)
    for (let j = 0; j < 2 * n; ++j) {
      const phi = ((j + 0.5) / (2 * n)) * 2 * Math.PI
      const v: V = [sinT * Math.cos(phi), sinT * Math.sin(phi), cosT]
      const f = oceanSpecular(normal, v, l, alpha) + oceanDiffuse(albedo, mu0, cosT)
      // dω = d(cosθ) dφ ; integrand f · cosθ
      sum += f * cosT * (1 / n) * ((2 * Math.PI) / (2 * n))
    }
  }
  return sum
}
