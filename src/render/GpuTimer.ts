import type { WebGLRenderer } from 'three'

interface PendingQuery {
  name: string
  query: WebGLQuery
}

/**
 * Per-pass GPU timing via EXT_disjoint_timer_query_webgl2. Results arrive a
 * few frames late; `stats()` returns rolling samples per pass name.
 * No-ops when the extension is unavailable.
 */
export class GpuTimer {
  private readonly gl: WebGL2RenderingContext
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null
  private pending: PendingQuery[] = []
  private active: PendingQuery | null = null
  private readonly samples = new Map<string, number[]>()
  enabled = true

  constructor(renderer: WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as typeof this.ext
  }

  get supported(): boolean {
    return this.ext !== null
  }

  begin(name: string): void {
    if (!this.ext || !this.enabled || this.active) return
    const query = this.gl.createQuery()
    if (!query) return
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query)
    this.active = { name, query }
  }

  end(): void {
    if (!this.ext || !this.active) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this.pending.push(this.active)
    this.active = null
  }

  poll(): void {
    if (!this.ext) return
    const gl = this.gl
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean
    const still: PendingQuery[] = []
    for (const p of this.pending) {
      const available = gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE) as boolean
      if (!available) {
        still.push(p)
        continue
      }
      if (!disjoint) {
        const ns = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number
        const list = this.samples.get(p.name) ?? []
        list.push(ns / 1e6)
        if (list.length > 240) list.shift()
        this.samples.set(p.name, list)
      }
      gl.deleteQuery(p.query)
    }
    this.pending = still.length > 64 ? still.slice(-64) : still
  }

  /** Per-pass p50/p95 in milliseconds over the retained samples. */
  stats(): Record<string, { p50: number; p95: number; count: number }> {
    const out: Record<string, { p50: number; p95: number; count: number }> = {}
    for (const [name, list] of this.samples) {
      const sorted = [...list].sort((a, b) => a - b)
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
      out[name] = { p50: at(0.5), p95: at(0.95), count: sorted.length }
    }
    return out
  }

  reset(): void {
    this.samples.clear()
  }

  dispose(): void {
    for (const p of this.pending) this.gl.deleteQuery(p.query)
    this.pending = []
  }
}
