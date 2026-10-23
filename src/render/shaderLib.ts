/**
 * Shader assembly helpers: `#include "path"` resolution, precision header,
 * and define diffing. All GLSL under src/shaders is registered as a chunk
 * keyed by its path relative to src/shaders without the extension
 * (e.g. `#include "common/math"`).
 */

export type ShaderChunks = Readonly<Record<string, string>>

const rawModules = import.meta.glob('../shaders/**/*.glsl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

export const shaderChunks: ShaderChunks = Object.fromEntries(
  Object.entries(rawModules).map(([path, src]) => [
    path.replace(/^\.\.\/shaders\//, '').replace(/\.glsl$/, ''),
    src,
  ]),
)

const INCLUDE_RE = /^[ \t]*#include\s+"([^"]+)"[ \t]*$/gm

export class ShaderIncludeError extends Error {}

/**
 * Recursively replaces `#include "name"` lines. Each chunk is inlined at most
 * once per shader (include-guard semantics); cycles throw.
 */
export function resolveIncludes(
  source: string,
  chunks: ShaderChunks = shaderChunks,
  stack: readonly string[] = [],
  included: Set<string> = new Set(),
): string {
  return source.replace(INCLUDE_RE, (_line, name: string) => {
    if (stack.includes(name)) {
      throw new ShaderIncludeError(`Cyclic #include: ${[...stack, name].join(' -> ')}`)
    }
    const chunk = chunks[name]
    if (chunk === undefined) {
      throw new ShaderIncludeError(`Unresolved #include "${name}"`)
    }
    if (included.has(name)) return `// (already included: ${name})`
    included.add(name)
    return `// begin ${name}\n${resolveIncludes(chunk, chunks, [...stack, name], included)}\n// end ${name}`
  })
}

export const PRECISION_HEADER = [
  'precision highp float;',
  'precision highp int;',
  'precision highp sampler2D;',
  'precision highp sampler3D;',
  'precision highp samplerCube;',
  'precision highp sampler2DArray;',
].join('\n')

/** Prepends the precision header and resolves includes. */
export function buildShader(source: string, chunks: ShaderChunks = shaderChunks): string {
  return `${PRECISION_HEADER}\n${resolveIncludes(source, chunks)}`
}

export type DefineValue = number | boolean | string | undefined | null
export type DefineInput = Readonly<Record<string, DefineValue>>
export type Defines = Record<string, string>

/**
 * Normalizes defines: `true` -> '1', `false`/null/undefined are omitted,
 * integers stay integers, non-integers keep a decimal point so GLSL parses
 * them as float literals.
 */
export function normalizeDefines(input: DefineInput): Defines {
  const out: Defines = {}
  for (const key of Object.keys(input).sort()) {
    const value = input[key]
    if (value === false || value === undefined || value === null) continue
    if (value === true) out[key] = '1'
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`Define ${key} is not finite`)
      out[key] = Number.isInteger(value) ? String(value) : formatFloat(value)
    } else out[key] = value
  }
  return out
}

export function formatFloat(value: number): string {
  const s = value.toPrecision(9)
  return /[.e]/.test(s) ? s : `${s}.0`
}

export function definesEqual(a: Readonly<Defines>, b: Readonly<Defines>): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => a[k] === b[k])
}

interface DefinesHolder {
  defines?: Record<string, unknown>
  needsUpdate: boolean
}

/**
 * Replaces material.defines with `next` only when they differ, so materials
 * recompile exactly when the define set changes and never otherwise.
 * Returns true if a recompile was requested.
 */
export function applyDefines(material: DefinesHolder, next: DefineInput): boolean {
  const normalized = normalizeDefines(next)
  const current = (material.defines ?? {}) as Defines
  if (definesEqual(current, normalized)) return false
  material.defines = normalized
  material.needsUpdate = true
  return true
}
