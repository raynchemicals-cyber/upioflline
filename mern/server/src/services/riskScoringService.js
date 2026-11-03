import { IsolationForest } from './isolationForest.js';
import { RelayNode } from '../models/RelayNode.js';
import { Transaction } from '../models/Transaction.js';

export class RiskScoringService {
  constructor() {
    this.threshold = parseInt(process.env.RISK_THRESHOLD || '50', 10);
    this.weightHopCount = parseInt(process.env.WEIGHT_HOP_COUNT || '15', 10);
    this.weightLatency = parseInt(process.env.WEIGHT_LATENCY || '20', 10);
    this.weightVelocity = parseInt(process.env.WEIGHT_VELOCITY || '25', 10);
    this.weightAmountDev = parseInt(process.env.WEIGHT_AMOUNT_DEV || '20', 10);
    this.weightRelayRep = parseInt(process.env.WEIGHT_RELAY_REP || '20', 10);

    // In-memory velocity tracker: senderVpa -> array of epoch ms timestamps
    this.senderVelocityHistory = new Map();

    this.forest = new IsolationForest({ numTrees: 40, subSampleSize: 64 });
    this.trainInitialModel();
  }

  /**
   * Generates a synthetic baseline dataset representing normal mesh traffic
   * and a small fraction of anomalies, and fits the Isolation Forest.
   */
  trainInitialModel() {
    const syntheticData = [];
    // 300 normal samples
    for (let i = 0; i < 300; i++) {
      const hops = 1 + Math.floor(Math.random() * 4); // 1-4 hops
      const latencySec = 10 + Math.random() * 300; // 10s - 5min
      const velocity = 1 + Math.floor(Math.random() * 2); // 1-2 txs
      const amount = 50 + Math.random() * 1000; // 50 - 1000
      const reputation = 90 + Math.random() * 10; // 90-100
      syntheticData.push([hops, latencySec, velocity, amount, reputation]);
    }
    // 20 anomalous samples (high hops, stale latency, rapid velocity, large amounts, low rep)
    for (let i = 0; i < 20; i++) {
      const hops = 6 + Math.floor(Math.random() * 8);
      const latencySec = 7200 + Math.random() * 50000;
      const velocity = 5 + Math.floor(Math.random() * 8);
      const amount = 3000 + Math.random() * 10000;
      const reputation = 20 + Math.random() * 40;
      syntheticData.push([hops, latencySec, velocity, amount, reputation]);
    }

    this.forest.fit(syntheticData);
  }

  /**
   * Evaluates payment risk using multi-signal heuristics + Isolation Forest.
   *
   * @param {object} params
   * @param {object} params.instruction Decrypted PaymentInstruction
   * @param {number} params.hopCount Number of hops the packet traversed
   * @param {string} params.bridgeNodeId Node ID of bridge that uploaded
   * @param {string[]} [params.relayNodes] Array of intermediate node IDs
   * @returns {Promise<{ riskScore: number, contributingFactors: string[], isFlagged: boolean }>}
   */
  async evaluateRisk({ instruction, hopCount, bridgeNodeId, relayNodes = [] }) {
    const contributingFactors = [];
    const now = Date.now();
    const signedAt = Number(instruction.signedAt) || now;
    const latencySeconds = Math.max(0, (now - signedAt) / 1000);
    const amount = Number(instruction.amount) || 0;

    // 1. Sender velocity calculation (payments within last 5 minutes)
    const velocityWindowMs = 5 * 60 * 1000;
    const pastTimestamps = this.senderVelocityHistory.get(instruction.senderVpa) || [];
    const recentTimestamps = pastTimestamps.filter((t) => now - t <= velocityWindowMs);
    recentTimestamps.push(now);
    this.senderVelocityHistory.set(instruction.senderVpa, recentTimestamps);
    const senderVelocity = recentTimestamps.length;

    // 2. Amount deviation calculation
    let avgAmount = 500;
    try {
      const pastTxs = await Transaction.find({ senderVpa: instruction.senderVpa })
        .sort({ _id: -1 })
        .limit(10);
      if (pastTxs.length > 0) {
        avgAmount = pastTxs.reduce((sum, tx) => sum + tx.amount, 0) / pastTxs.length;
      }
    } catch {
      avgAmount = 500;
    }
    const amountRatio = avgAmount > 0 ? amount / avgAmount : 1;

    // 3. Relay node reputation
    const nodesToCheck = Array.from(new Set([bridgeNodeId, ...(relayNodes || [])])).filter(Boolean);
    let minReputation = 100;
    let offendingNode = null;

    for (const nodeId of nodesToCheck) {
      let nodeRecord = await RelayNode.findOne({ nodeId });
      if (!nodeRecord) {
        nodeRecord = await RelayNode.create({ nodeId, reputation: 100 });
      }
      if (nodeRecord.reputation < minReputation) {
        minReputation = nodeRecord.reputation;
        offendingNode = nodeId;
      }
    }

    // Heuristic Rule Scoring (0-100)
    let ruleScore = 0;

    // Hop count penalty
    if (hopCount >= 7) {
      ruleScore += this.weightHopCount;
      contributingFactors.push(`Critical hop count (${hopCount} hops traversed)`);
    } else if (hopCount >= 5) {
      ruleScore += this.weightHopCount * 0.6;
      contributingFactors.push(`Elevated hop count (${hopCount} hops)`);
    }

    // Latency penalty
    if (latencySeconds > 43200) { // > 12 hours
      ruleScore += this.weightLatency;
      contributingFactors.push(`High offline sync latency (${(latencySeconds / 3600).toFixed(1)} hours)`);
    } else if (latencySeconds > 3600) { // > 1 hour
      ruleScore += this.weightLatency * 0.5;
      contributingFactors.push(`Moderate sync latency (${(latencySeconds / 60).toFixed(0)} minutes)`);
    }

    // Velocity burst penalty
    if (senderVelocity >= 5) {
      ruleScore += this.weightVelocity;
      contributingFactors.push(`High sender velocity (${senderVelocity} payments in 5 minutes without sync)`);
    } else if (senderVelocity >= 3) {
      ruleScore += this.weightVelocity * 0.5;
      contributingFactors.push(`Elevated sender velocity (${senderVelocity} payments in 5 minutes)`);
    }

    // Amount deviation penalty
    if (amountRatio >= 4 || amount > 4000) {
      ruleScore += this.weightAmountDev;
      contributingFactors.push(`Large amount spike (₹${amount.toFixed(2)} vs typical ₹${avgAmount.toFixed(2)})`);
    } else if (amountRatio >= 2.5) {
      ruleScore += this.weightAmountDev * 0.5;
      contributingFactors.push(`Above average amount (₹${amount.toFixed(2)})`);
    }

    // Relay reputation penalty
    if (minReputation < 50) {
      ruleScore += this.weightRelayRep;
      contributingFactors.push(`Compromised relay route (node ${offendingNode} reputation ${minReputation}/100)`);
    } else if (minReputation < 80) {
      ruleScore += this.weightRelayRep * 0.6;
      contributingFactors.push(`Low relay node reputation (${offendingNode}: ${minReputation}/100)`);
    }

    // Isolation Forest anomaly scoring
    const featureVector = [hopCount, latencySeconds, senderVelocity, amount, minReputation];
    const rawForestScore = this.forest.score(featureVector); // 0.0 to 1.0
    // Transform anomaly score: 0.5 is baseline, > 0.65 is anomalous
    const forestScoreScaled = Math.min(100, Math.max(0, (rawForestScore - 0.4) * 160));

    if (forestScoreScaled >= 60 && contributingFactors.length === 0) {
      contributingFactors.push(`Unsupervised pattern anomaly (score: ${forestScoreScaled.toFixed(0)})`);
    }

    // Final risk score considers both transparent heuristic rules and unsupervised Isolation Forest
    const finalScore = Math.min(
      100,
      Math.max(ruleScore, Math.round(0.5 * ruleScore + 0.5 * forestScoreScaled))
    );
    const isFlagged = finalScore >= this.threshold;

    return {
      riskScore: finalScore,
      contributingFactors,
      isFlagged,
    };
  }

  /**
   * Lowers relay node reputation when it delivers an invalid or tampered packet.
   * @param {string} nodeId
   * @param {number} penalty
   */
  async penalizeRelay(nodeId, penalty = 20) {
    if (!nodeId) return;
    await RelayNode.findOneAndUpdate(
      { nodeId },
      {
        $inc: { invalidRelayed: 1, totalRelayed: 1 },
        $set: { updatedAt: new Date() },
      },
      { upsert: true, new: true }
    );
    await RelayNode.updateOne(
      { nodeId },
      [{ $set: { reputation: { $max: [0, { $subtract: ['$reputation', penalty] }] } } }]
    );
  }

  /**
   * Rewards relay node reputation on valid settlement.
   * @param {string} nodeId
   */
  async rewardRelay(nodeId, reward = 2) {
    if (!nodeId) return;
    await RelayNode.findOneAndUpdate(
      { nodeId },
      {
        $inc: { totalRelayed: 1 },
        $set: { updatedAt: new Date() },
      },
      { upsert: true, new: true }
    );
    await RelayNode.updateOne(
      { nodeId },
      [{ $set: { reputation: { $min: [100, { $add: ['$reputation', reward] }] } } }]
    );
  }

  clearVelocityHistory() {
    this.senderVelocityHistory.clear();
  }
}

export const riskScoringService = new RiskScoringService();
