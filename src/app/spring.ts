/**
 * Value smoothing equivalent to motion's `useSpring` with takram's
 * `springOptions` ({ mass: 1, damping: 20 }, default stiffness 100). That is
 * a critically damped spring (ζ = 20 / (2·√(100·1)) = 1, ω = 10 rad/s), so it
 * is integrated in closed form and never overshoots.
 */
export const SPRING = { mass: 1, stiffness: 100, damping: 20 } as const
const OMEGA = Math.sqrt(SPRING.stiffness / SPRING.mass)

export class Spring {
  value: number
  velocity = 0
  target: number

  constructor(initial: number) {
    this.value = initial
    this.target = initial
  }

  set(target: number): void {
    this.target = target
  }

  /** Jump to the target without animating. */
  snap(target = this.target): void {
    this.target = target
    this.value = target
    this.velocity = 0
  }

  get settled(): boolean {
    return this.value === this.target && this.velocity === 0
  }

  step(dt: number): number {
    if (this.settled || !(dt > 0)) return this.value
    const d0 = this.value - this.target
    const b = this.velocity + OMEGA * d0
    const e = Math.exp(-OMEGA * dt)
    const d = (d0 + b * dt) * e
    this.velocity = (this.velocity - OMEGA * b * dt) * e
    this.value = this.target + d
    // Rest thresholds (motion settles within restDelta / restSpeed).
    if (Math.abs(d) < 1e-4 && Math.abs(this.velocity) < 1e-3) this.snap()
    return this.value
  }
}
