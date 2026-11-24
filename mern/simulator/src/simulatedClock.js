/**
 * simulatedClock.js — Deterministic virtual clock for delay metrics
 *
 * Using simulated time rather than Date.now() / setTimeout ensures:
 *  - Delay measurements are independent of host CPU load or scheduling jitter.
 *  - Experiment runs produce identical timing regardless of when they execute.
 *  - Total simulated time is a meaningful, reproducible metric.
 *
 * The dashboard/live-simulator path keeps useRealTime=true in MeshNetwork so
 * real-world timing is preserved; experiments set useRealTime=false and use
 * this clock exclusively.
 *
 * Usage:
 *   const clock = new SimulatedClock();
 *   clock.advance(300);   // simulate one 300 ms hop
 *   clock.now;            // 300
 */

export class SimulatedClock {
  /**
   * @param {number} [startMs=0]  Initial simulated time in milliseconds
   */
  constructor(startMs = 0) {
    this._now = startMs;
  }

  /** Current simulated timestamp in ms */
  get now() {
    return this._now;
  }

  /**
   * Advance the clock by the given duration.
   * Negative values are silently ignored (time cannot go backwards).
   * @param {number} ms
   * @returns {number}  New simulated timestamp
   */
  advance(ms) {
    if (ms > 0) this._now += ms;
    return this._now;
  }

  /**
   * Reset the clock to a given start time.
   * @param {number} [startMs=0]
   */
  reset(startMs = 0) {
    this._now = startMs;
  }

  /** Snapshot the current time (alias for .now). */
  snapshot() {
    return this._now;
  }
}
