import { IsolationForest } from './isolationForest.js';
import { RelayNode } from '../models/RelayNode.js';
import { Transaction } from '../models/Transaction.js';

/**
 * RiskScoringService — multi-signal fraud scorer + relay trust manager
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * TRUST SCORE UPDATE RULE (server-side mirror of simulator/trustManager.js)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *   α = 0.15   (EMA smoothing factor)
 *   sample  = clamp(currentTrustScore + delta, 0, 100)
 *   newScore = α × sample + (1 − α) × currentTrustScore
 *
 * ASYMMETRIC DELTAS:
 *   forward_ok          +3   correct hop in a successful delivery
 *   delivered           +5   packet reached a bridge node
 *   drop               −8   relay dropped a packet
 *   slow               −4   slow forward
 *   tamper            −35   directly tampered ciphertext ← hardest penalty
 *   path_contaminated  −5   on the path of a tampered packet (blame share)
 *
 * INITIAL TRUST: 80 (new, unseen relay nodes start here)
 * CLASSIFICATION:
 *   trustScore ≥ 70  →  HONEST
 *   40 ≤ score < 70  →  UNRELIABLE
 *   score < 40       →  MALICIOUS
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * BLAME ATTRIBUTION (server side — tamperer identity is UNKNOWN)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * When ciphertext decryption fails at the bridge ingestion layer:
 *
 *   Case A — relayNodes path is KNOWN (X-Relay-Nodes header present):
 *     • Last relay before bridge  → updateTrust('tamper')   [most likely culprit]
 *     • Bridge node               → updateTrust('path_contaminated')
 *     • Other relay nodes in path → updateTrust('path_contaminated')
 *
 *   Case B — relayNodes path is UNKNOWN (no X-Relay-Nodes header):
 *     • Bridge node               → updateTrust('tamper')   [only known node]
 *
 * On successful settlement:
 *   • Bridge node     → updateTrust('delivered')
 *   • Each relay node → updateTrust('forward_ok')
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * FRAUD SCORER uses trustScore (not legacy reputation)
 * ══════════════════════════════════════════════════════════════════════════════
 * effectiveTrust = Math.min(trustScore, reputation) so that:
 *   a) Pre-existing test fixtures that set only `reputation` still trigger
 *      the low-trust penalty (backward compat).
 *   b) The new trust system (which keeps reputation = Math.round(trustScore))
 *      uses the trustScore value correctly.
 */

export class RiskScoringService {
  constructor() {
    this.threshold      = parseInt(process.env.RISK_THRESHOLD    || '50', 10);
    this.weightHopCount = parseInt(process.env.WEIGHT_HOP_COUNT  || '15', 10);
    this.weightLatency  = parseInt(process.env.WEIGHT_LATENCY    || '20', 10);
    this.weightVelocity = parseInt(process.env.WEIGHT_VELOCITY   || '25', 10);
    this.weightAmountDev= parseInt(process.env.WEIGHT_AMOUNT_DEV || '20', 10);
    this.weightRelayRep = parseInt(process.env.WEIGHT_RELAY_REP  || '20', 10);

    this.senderVelocityHistory = new Map();

    this.forest = new IsolationForest({ numTrees: 40, subSampleSize: 64 });
    this.trainInitialModel();
  }

  /** EMA trust update deltas (kept in sync with simulator/trustManager.js). */
  static TRUST_DELTAS = Object.freeze({
    forward_ok:        +3,
    delivered:         +5,
    drop:              -8,
    slow:              -4,
    tamper:           -35,
    path_contaminated: -5,
  });

  static TRUST_ALPHA   = 0.15;
  static INITIAL_TRUST = 80;

  /**
   * Classify a trust score into a human-readable label.
   * @param {number} score
   * @returns {'HONEST'|'UNRELIABLE'|'MALICIOUS'}
   */
  static classify(score) {
    if (score >= 70) return 'HONEST';
    if (score >= 40) return 'UNRELIABLE';
    return 'MALICIOUS';
  }

  trainInitialModel() {
    // Use a fixed-seed Mulberry32 PRNG so the initial model is reproducible.
    // This avoids raw Math.random() in production paths and keeps test runs
    // deterministic regardless of when the server starts.
    let s = 0x9e3779b9 >>> 0; // fixed seed
    const rng = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    };

    const syntheticData = [];
    // 300 normal samples
    for (let i = 0; i < 300; i++) {
      const hops       = 1 + Math.floor(rng() * 4);
      const latencySec = 10 + rng() * 300;
      const velocity   = 1 + Math.floor(rng() * 2);
      const amount     = 50 + rng() * 1000;
      const trust      = 70 + rng() * 30; // HONEST range
      syntheticData.push([hops, latencySec, velocity, amount, trust]);
    }
    // 20 anomalous samples
    for (let i = 0; i < 20; i++) {
      const hops       = 6 + Math.floor(rng() * 8);
      const latencySec = 7200 + rng() * 50000;
      const velocity   = 5 + Math.floor(rng() * 8);
      const amount     = 3000 + rng() * 10000;
      const trust      = 10 + rng() * 40; // MALICIOUS/UNRELIABLE range
      syntheticData.push([hops, latencySec, velocity, amount, trust]);
    }
    this.forest.fit(syntheticData);
  }

  /**
   * Evaluates payment risk using multi-signal heuristics + Isolation Forest.
   * Uses trustScore (not legacy reputation) for the relay signal.
   *
   * @param {object} params
   * @param {object}   params.instruction   Decrypted PaymentInstruction
   * @param {number}   params.hopCount
   * @param {string}   params.bridgeNodeId
   * @param {string[]} [params.relayNodes]
   * @returns {Promise<{ riskScore, contributingFactors, isFlagged }>}
   */
  async evaluateRisk({ instruction, hopCount, bridgeNodeId, relayNodes = [] }) {
    const contributingFactors = [];
    const now        = Date.now();
    const signedAt   = Number(instruction.signedAt) || now;
    const latencySec = Math.max(0, (now - signedAt) / 1000);
    const amount     = Number(instruction.amount) || 0;

    // 1. Sender velocity
    const velocityWindowMs  = 5 * 60 * 1000;
    const pastTimestamps    = this.senderVelocityHistory.get(instruction.senderVpa) || [];
    const recentTimestamps  = pastTimestamps.filter((t) => now - t <= velocityWindowMs);
    recentTimestamps.push(now);
    this.senderVelocityHistory.set(instruction.senderVpa, recentTimestamps);
    const senderVelocity = recentTimestamps.length;

    // 2. Amount deviation
    let avgAmount = 500;
    try {
      const pastTxs = await Transaction.find({ senderVpa: instruction.senderVpa })
        .sort({ _id: -1 })
        .limit(10);
      if (pastTxs.length > 0) {
        avgAmount = pastTxs.reduce((s, tx) => s + tx.amount, 0) / pastTxs.length;
      }
    } catch { avgAmount = 500; }
    const amountRatio = avgAmount > 0 ? amount / avgAmount : 1;

    // 3. Relay trust score
    // effectiveTrust = min(trustScore, reputation) for backward compatibility:
    // legacy test fixtures set only `reputation` (not trustScore), so
    // Math.min(80 [default trustScore], 30 [explicit reputation]) = 30 → triggers penalty.
    const nodesToCheck = Array.from(new Set([bridgeNodeId, ...(relayNodes || [])])).filter(Boolean);
    let minTrust      = 100;
    let offendingNode = null;

    for (const nodeId of nodesToCheck) {
      let doc = await RelayNode.findOne({ nodeId });
      if (!doc) {
        doc = await RelayNode.create({ nodeId, trustScore: 80, reputation: 80 });
      }
      const effectiveTrust = Math.min(
        typeof doc.trustScore === 'number' ? doc.trustScore : 80,
        typeof doc.reputation === 'number' ? doc.reputation : 80
      );
      if (effectiveTrust < minTrust) {
        minTrust      = effectiveTrust;
        offendingNode = nodeId;
      }
    }

    // ── Heuristic rule scoring (0–100) ──────────────────────────────────────
    let ruleScore = 0;

    if (hopCount >= 7) {
      ruleScore += this.weightHopCount;
      contributingFactors.push(`Critical hop count (${hopCount} hops traversed)`);
    } else if (hopCount >= 5) {
      ruleScore += this.weightHopCount * 0.6;
      contributingFactors.push(`Elevated hop count (${hopCount} hops)`);
    }

    if (latencySec > 43200) {
      ruleScore += this.weightLatency;
      contributingFactors.push(`High offline sync latency (${(latencySec / 3600).toFixed(1)} hours)`);
    } else if (latencySec > 3600) {
      ruleScore += this.weightLatency * 0.5;
      contributingFactors.push(`Moderate sync latency (${(latencySec / 60).toFixed(0)} minutes)`);
    }

    if (senderVelocity >= 5) {
      ruleScore += this.weightVelocity;
      contributingFactors.push(`High sender velocity (${senderVelocity} payments in 5 minutes without sync)`);
    } else if (senderVelocity >= 3) {
      ruleScore += this.weightVelocity * 0.5;
      contributingFactors.push(`Elevated sender velocity (${senderVelocity} payments in 5 minutes)`);
    }

    if (amountRatio >= 4 || amount > 4000) {
      ruleScore += this.weightAmountDev;
      contributingFactors.push(`Large amount spike (₹${amount.toFixed(2)} vs typical ₹${avgAmount.toFixed(2)})`);
    } else if (amountRatio >= 2.5) {
      ruleScore += this.weightAmountDev * 0.5;
      contributingFactors.push(`Above average amount (₹${amount.toFixed(2)})`);
    }

    // Trust-based relay penalty (using new trustScore thresholds)
    if (minTrust < 40) {
      ruleScore += this.weightRelayRep;
      contributingFactors.push(
        `MALICIOUS relay on route (${offendingNode} trust ${minTrust.toFixed(1)}/100)`
      );
    } else if (minTrust < 70) {
      ruleScore += this.weightRelayRep * 0.6;
      contributingFactors.push(
        `UNRELIABLE relay on route (${offendingNode}: ${minTrust.toFixed(1)}/100)`
      );
    }

    // ── Isolation Forest ─────────────────────────────────────────────────────
    const featureVector    = [hopCount, latencySec, senderVelocity, amount, minTrust];
    const rawForestScore   = this.forest.score(featureVector);
    const forestScoreScaled = Math.min(100, Math.max(0, (rawForestScore - 0.4) * 160));

    if (forestScoreScaled >= 60 && contributingFactors.length === 0) {
      contributingFactors.push(`Unsupervised pattern anomaly (score: ${forestScoreScaled.toFixed(0)})`);
    }

    const finalScore = Math.min(
      100,
      Math.max(ruleScore, Math.round(0.5 * ruleScore + 0.5 * forestScoreScaled))
    );
    const isFlagged  = finalScore >= this.threshold;

    return { riskScore: finalScore, contributingFactors, isFlagged };
  }

  // ─── Trust Management ─────────────────────────────────────────────────────

  /**
   * Apply a named trust event to a relay node using the EMA update rule.
   *
   * Update rule:
   *   sample   = clamp(current + delta, 0, 100)
   *   newScore = α × sample + (1 − α) × current    where α = 0.15
   *
   * @param {string} nodeId
   * @param {string} event  One of: forward_ok, delivered, drop, slow, tamper, path_contaminated
   * @returns {Promise<number|null>}  New trust score, or null if nodeId is falsy
   */
  async updateTrust(nodeId, event) {
    if (!nodeId) return null;

    const delta = RiskScoringService.TRUST_DELTAS[event];
    if (delta === undefined) return null;

    // Find or create the document
    let doc = await RelayNode.findOne({ nodeId });
    if (!doc) {
      doc = await RelayNode.create({
        nodeId,
        trustScore: RiskScoringService.INITIAL_TRUST,
        reputation: RiskScoringService.INITIAL_TRUST,
      });
    }

    const current  = typeof doc.trustScore === 'number'
      ? doc.trustScore
      : RiskScoringService.INITIAL_TRUST;
    const alpha    = RiskScoringService.TRUST_ALPHA;
    const sample   = Math.min(100, Math.max(0, current + delta));
    const newScore = alpha * sample + (1 - alpha) * current;
    const classification = RiskScoringService.classify(newScore);

    // Build counter increments
    const inc = { totalRelayed: 1 };
    if (event === 'forward_ok' || event === 'delivered') inc.forwardedOk   = 1;
    if (event === 'drop')                                inc.drops          = 1;
    if (event === 'slow')                                inc.slowForwards   = 1;
    if (event === 'tamper' || event === 'path_contaminated') inc.invalidRelayed = 1;

    await RelayNode.updateOne(
      { nodeId },
      {
        $set: {
          trustScore:     newScore,
          reputation:     Math.round(newScore), // backward compat
          classification,
          lastEventAt:    new Date(),
        },
        $inc: inc,
      }
    );

    return newScore;
  }

  /**
   * Penalize a relay node.
   * Thin wrapper around updateTrust(); kept for backward compatibility.
   * penalty ≥ 20 maps to 'tamper', otherwise 'path_contaminated'.
   *
   * @param {string} nodeId
   * @param {number} [penalty=20]
   */
  async penalizeRelay(nodeId, penalty = 20) {
    return this.updateTrust(nodeId, penalty >= 20 ? 'tamper' : 'path_contaminated');
  }

  /**
   * Reward a relay node on successful settlement.
   * Thin wrapper around updateTrust(); kept for backward compatibility.
   * @param {string} nodeId
   */
  async rewardRelay(nodeId) {
    return this.updateTrust(nodeId, 'delivered');
  }

  clearVelocityHistory() {
    this.senderVelocityHistory.clear();
  }
}

export const riskScoringService = new RiskScoringService();
