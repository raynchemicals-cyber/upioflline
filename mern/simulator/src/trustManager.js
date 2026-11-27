/**
 * trustManager.js — In-simulator EMA trust score tracker
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * TRUST SCORE UPDATE RULE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Trust score T ∈ [0, 100] is maintained as an Exponential Moving Average
 * (EMA) so that no single event can flip the classification:
 *
 *   α   = TRUST_ALPHA = 0.15     (smoothing factor; lower → slower to change)
 *   sample  = clamp(T + delta, 0, 100)
 *   T_new   = α × sample + (1 − α) × T
 *
 * ASYMMETRIC DELTAS (tampering penalty >> forwarding reward):
 *   forward_ok          +3   correct hop in a successful delivery path
 *   delivered           +5   packet reached a bridge node
 *   drop               −8   relay dropped a packet (detected by tracking)
 *   slow               −4   forward took > 2× median hop delay
 *   tamper            −35   directly modified ciphertext  ← hardest penalty
 *   path_contaminated  −5   on the path of a tampered packet (blame share)
 *
 * INITIAL TRUST: 80  (innocent until proven guilty, but not fully trusted)
 *
 * CLASSIFICATION THRESHOLDS:
 *   T ≥ 70   →  HONEST
 *   40 ≤ T < 70  →  UNRELIABLE
 *   T < 40   →  MALICIOUS
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * BLAME ATTRIBUTION
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * When a tampered packet is detected:
 *   • The DIRECT TAMPERER (the simulator knows exactly who) → DELTA_TAMPER (−35)
 *   • Every OTHER relay on that path                       → DELTA_PATH_CONTAMINATED (−5)
 *   • The bridge that submitted the bad packet              → DELTA_PATH_CONTAMINATED (−5)
 *
 * On the SERVER SIDE (where the tamperer is unknown):
 *   • The LAST RELAY before the bridge     → DELTA_TAMPER (−35)  [most likely culprit]
 *   • All other relays in path             → DELTA_PATH_CONTAMINATED (−5)
 *   • The bridge                           → DELTA_PATH_CONTAMINATED (−5)
 *   • If path unknown (empty relayNodes)   → bridge gets full DELTA_TAMPER
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * DELIVERY RECEIPT / TIMEOUT
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Dropped packets reduce trust: when a node's shouldDrop() returns true, or
 * the network-level dropRate fires, the FORWARDING node (the one that failed
 * to pass the packet on) receives a DELTA_DROP (−8) penalty applied after the
 * BFS loop completes. This simulates a delivery-receipt mechanism: a successful
 * end-to-end delivery is a positive receipt; absence of delivery attributed to
 * a specific node is a negative receipt (timeout-equivalent).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * EXPLORATION / ANTI-PARTITION FALLBACK
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Trust-aware routing uses ε-greedy exploration (default ε = 0.10):
 *   • With probability ε, one random peer is added to the forwarding set
 *     regardless of its trust score, so new/recovering relays get traffic.
 *   • If NO peer meets minTrustThreshold, the routing FALLS BACK to flooding
 *     all peers, preventing network partitions.
 */

export const TRUST_ALPHA    = 0.15;
export const INITIAL_TRUST  = 80;

/** EMA delta per event type. Asymmetric by design. */
export const DELTAS = Object.freeze({
  forward_ok:        +3,
  delivered:         +5,
  drop:              -8,
  slow:              -4,
  tamper:           -35,
  path_contaminated: -5,
});

export const THRESHOLD_HONEST      = 70;
export const THRESHOLD_UNRELIABLE  = 40;

/**
 * Classify a numeric trust score.
 * @param {number} score
 * @returns {'HONEST'|'UNRELIABLE'|'MALICIOUS'}
 */
export function classify(score) {
  if (score >= THRESHOLD_HONEST)     return 'HONEST';
  if (score >= THRESHOLD_UNRELIABLE) return 'UNRELIABLE';
  return 'MALICIOUS';
}

/** Apply EMA update to current score with given delta. */
function emaUpdate(current, delta) {
  const sample = Math.min(100, Math.max(0, current + delta));
  return TRUST_ALPHA * sample + (1 - TRUST_ALPHA) * current;
}

export class TrustManager {
  constructor() {
    /** @type {Map<string, number>} nodeId → trust score */
    this.scores = new Map();
    /**
     * Ordered audit log — useful for plotting trust evolution in experiments
     * and for verifying the update rule in tests.
     * @type {Array<{nodeId,event,delta,before,after,classification}>}
     */
    this.eventLog = [];
  }

  /**
   * Get the current trust score for a node.
   * Initialises at INITIAL_TRUST if the node is unknown.
   * @param {string} nodeId
   * @returns {number}
   */
  getScore(nodeId) {
    if (!this.scores.has(nodeId)) {
      this.scores.set(nodeId, INITIAL_TRUST);
    }
    return this.scores.get(nodeId);
  }

  /**
   * Apply a named trust event using the EMA update rule.
   * @param {string} nodeId
   * @param {keyof typeof DELTAS} event
   * @returns {number}  New trust score
   */
  update(nodeId, event) {
    const delta = DELTAS[event];
    if (delta === undefined) return this.getScore(nodeId);

    const before = this.getScore(nodeId);
    const after  = emaUpdate(before, delta);
    this.scores.set(nodeId, after);

    this.eventLog.push({
      nodeId,
      event,
      delta,
      before: parseFloat(before.toFixed(4)),
      after:  parseFloat(after.toFixed(4)),
      classification: classify(after),
    });

    return after;
  }

  /**
   * Classify a node by its current trust score.
   * @param {string} nodeId
   * @returns {'HONEST'|'UNRELIABLE'|'MALICIOUS'}
   */
  classify(nodeId) {
    return classify(this.getScore(nodeId));
  }

  /**
   * Snapshot of all known scores.
   * @returns {Object.<string, {score: number, classification: string}>}
   */
  snapshot() {
    const result = {};
    for (const [id, score] of this.scores.entries()) {
      result[id] = {
        score:          parseFloat(score.toFixed(3)),
        classification: classify(score),
      };
    }
    return result;
  }

  /** Reset all scores and the event log (call between experiment runs). */
  reset() {
    this.scores.clear();
    this.eventLog = [];
  }
}
