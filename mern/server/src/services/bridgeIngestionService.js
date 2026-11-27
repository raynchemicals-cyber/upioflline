import { decrypt, hashCiphertext } from '../utils/crypto.js';
import { idempotencyService }   from './idempotencyService.js';
import { settlementService }    from './settlementService.js';
import { riskScoringService }   from './riskScoringService.js';
import { metricsService }       from './metricsService.js';
import { FlaggedPayment }       from '../models/FlaggedPayment.js';

/**
 * BridgeIngestionService — orchestrates the bridge ingestion pipeline
 *
 * Pipeline stages:
 *  1. Hash ciphertext (SHA-256)
 *  2. Idempotency gate (in-memory SETNX)
 *  3. Hybrid decryption + GCM auth-tag validation
 *  4. Freshness window check (replay & future-dating protection)
 *  5. AI Fraud & Risk Scoring (Isolation Forest + heuristics)
 *  6. Atomic settlement OR insertion into flagged_payments
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * BLAME ATTRIBUTION (called on decryption failure)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * The server cannot know exactly which relay tampered with the ciphertext.
 * We apportion blame based on the relay path supplied via X-Relay-Nodes:
 *
 *   Case A — X-Relay-Nodes IS present:
 *     • Last relay in path → updateTrust('tamper')   [most likely culprit, −35]
 *     • Bridge node        → updateTrust('path_contaminated')  [−5]
 *     • Other relay nodes  → updateTrust('path_contaminated')  [−5 each]
 *
 *   Case B — X-Relay-Nodes is ABSENT (path unknown):
 *     • Bridge node        → updateTrust('tamper')   [only known node, −35]
 *
 * On successful settlement, every node on the path is rewarded:
 *   • Bridge node     → updateTrust('delivered')  [+5]
 *   • Each relay node → updateTrust('forward_ok') [+3]
 */
export class BridgeIngestionService {
  constructor() {
    this.maxAgeSeconds = parseInt(process.env.PACKET_MAX_AGE_SECONDS || '86400', 10);
  }

  /**
   * @param {object} packet        { packetId, ttl, createdAt, ciphertext }
   * @param {string} bridgeNodeId  Node ID of bridge that uploaded
   * @param {number} hopCount
   * @param {string[]} [relayNodes]  Intermediate relay node IDs (path order)
   * @returns {Promise<object>}  IngestResult
   */
  async ingest(packet, bridgeNodeId = 'unknown', hopCount = 0, relayNodes = []) {
    try {
      if (!packet || !packet.ciphertext) {
        return {
          outcome:       'INVALID',
          packetHash:    '?',
          reason:        'missing_ciphertext',
          transactionId: null,
        };
      }

      const packetHash = hashCiphertext(
        packet.getCiphertext ? packet.getCiphertext() : packet.ciphertext
      );

      // ── 1. Idempotency Gate ──────────────────────────────────────────────
      if (!idempotencyService.claim(packetHash)) {
        metricsService.recordDuplicate();
        console.log(
          `DUPLICATE packet ${packetHash.substring(0, 12)}... from bridge ${bridgeNodeId} - dropped`
        );
        return {
          outcome:       'DUPLICATE_DROPPED',
          packetHash,
          reason:        null,
          transactionId: null,
        };
      }

      // ── 2. Decrypt & Tamper Check ────────────────────────────────────────
      let instruction;
      try {
        instruction = decrypt(packet.ciphertext);
      } catch (err) {
        metricsService.recordTampered();
        console.warn(
          `Decryption failed for packet ${packetHash.substring(0, 12)}...: ${err.message}`
        );

        // ── Blame attribution ──────────────────────────────────────────────
        await this._attributeTamperBlame(bridgeNodeId, relayNodes);

        return {
          outcome:       'INVALID',
          packetHash,
          reason:        'decryption_failed',
          transactionId: null,
        };
      }

      // ── 3. Freshness Check ───────────────────────────────────────────────
      const signedAt   = Number(instruction.signedAt) || 0;
      const ageSeconds = (Date.now() - signedAt) / 1000;

      if (ageSeconds > this.maxAgeSeconds) {
        metricsService.recordStale();
        console.warn(`Packet ${packetHash.substring(0, 12)}... too old (${ageSeconds}s), rejected`);
        return {
          outcome:       'INVALID',
          packetHash,
          reason:        'stale_packet',
          transactionId: null,
        };
      }

      if (ageSeconds < -300) {
        metricsService.recordStale();
        console.warn(`Packet ${packetHash.substring(0, 12)}... future-dated, rejected`);
        return {
          outcome:       'INVALID',
          packetHash,
          reason:        'future_dated',
          transactionId: null,
        };
      }

      // ── 4. AI Fraud & Risk Scoring ───────────────────────────────────────
      const risk = await riskScoringService.evaluateRisk({
        instruction,
        hopCount,
        bridgeNodeId,
        relayNodes,
      });

      if (risk.isFlagged) {
        console.warn(
          `FLAGGED packet ${packetHash.substring(0, 12)}... risk=${risk.riskScore}: ` +
          risk.contributingFactors.join('; ')
        );
        await FlaggedPayment.findOneAndUpdate(
          { packetHash },
          {
            packetId:           packet.packetId,
            packetHash,
            ciphertext:         packet.ciphertext,
            senderVpa:          instruction.senderVpa,
            receiverVpa:        instruction.receiverVpa,
            amount:             instruction.amount,
            signedAt:           new Date(instruction.signedAt),
            bridgeNodeId,
            hopCount,
            riskScore:          risk.riskScore,
            contributingFactors:risk.contributingFactors,
            status:             'PENDING_REVIEW',
          },
          { upsert: true, new: true }
        );

        return {
          outcome:            'FLAGGED',
          packetHash,
          reason:             'risk_score_exceeded',
          transactionId:      null,
          riskScore:          risk.riskScore,
          contributingFactors:risk.contributingFactors,
        };
      }

      // ── 5. Atomic Settlement ─────────────────────────────────────────────
      const tx = await settlementService.settle(instruction, packetHash, bridgeNodeId, hopCount);

      if (tx.status !== 'REJECTED') {
        metricsService.recordDelivered({ hopCount });
      } else {
        metricsService.recordDropped();
      }

      // Reward every node on the successful path
      await this._rewardPath(bridgeNodeId, relayNodes);

      return {
        outcome:       tx.status === 'REJECTED' ? 'REJECTED' : 'SETTLED',
        packetHash,
        reason:        tx.status === 'REJECTED' ? 'insufficient_balance' : null,
        transactionId: tx.id,
      };
    } catch (err) {
      console.error('Ingestion error:', err);
      return {
        outcome:       'INVALID',
        packetHash:    '?',
        reason:        `internal_error: ${err.message}`,
        transactionId: null,
      };
    }
  }

  // ─── Trust helpers ─────────────────────────────────────────────────────────

  /**
   * Attribute blame when ciphertext fails GCM verification.
   *
   * @param {string}   bridgeNodeId
   * @param {string[]} relayNodes    Relay path in order (may be empty)
   */
  async _attributeTamperBlame(bridgeNodeId, relayNodes) {
    const penalize = (id, event) =>
      riskScoringService.updateTrust(id, event).catch(() => {});

    if (relayNodes.length > 0) {
      // Last relay before bridge is the most likely tamperer
      const lastRelay = relayNodes[relayNodes.length - 1];
      await penalize(lastRelay, 'tamper');

      // Bridge submitted the bad packet (contamination penalty)
      await penalize(bridgeNodeId, 'path_contaminated');

      // All other relays in path share partial blame
      for (const nodeId of relayNodes.slice(0, -1)) {
        await penalize(nodeId, 'path_contaminated');
      }
    } else {
      // No relay path known — bridge is the only node we can penalize
      await penalize(bridgeNodeId, 'tamper');
    }
  }

  /**
   * Reward every node on a successful delivery path.
   *
   * @param {string}   bridgeNodeId
   * @param {string[]} relayNodes
   */
  async _rewardPath(bridgeNodeId, relayNodes) {
    const reward = (id, event) =>
      riskScoringService.updateTrust(id, event).catch(() => {});

    await reward(bridgeNodeId, 'delivered');
    for (const nodeId of relayNodes) {
      await reward(nodeId, 'forward_ok');
    }
  }

  // ─── Review ───────────────────────────────────────────────────────────────

  /**
   * Human-in-the-loop review of a flagged payment.
   * @param {string} flaggedId
   * @param {'approve'|'reject'} decision
   */
  async reviewFlaggedPayment(flaggedId, decision) {
    const flagged = await FlaggedPayment.findById(flaggedId);
    if (!flagged) {
      throw new Error(`Flagged payment not found: ${flaggedId}`);
    }
    if (flagged.status !== 'PENDING_REVIEW') {
      throw new Error(`Payment already reviewed: status is ${flagged.status}`);
    }

    if (decision === 'approve') {
      const instruction = decrypt(flagged.ciphertext);
      const tx          = await settlementService.settle(
        instruction,
        flagged.packetHash,
        flagged.bridgeNodeId,
        flagged.hopCount
      );

      flagged.status         = 'APPROVED';
      flagged.reviewedAt     = new Date();
      flagged.reviewDecision = 'approve';
      await flagged.save();

      return { outcome: 'SETTLED', packetHash: flagged.packetHash, transactionId: tx.id };
    } else if (decision === 'reject') {
      flagged.status         = 'REJECTED';
      flagged.reviewedAt     = new Date();
      flagged.reviewDecision = 'reject';
      await flagged.save();

      return { outcome: 'REJECTED', packetHash: flagged.packetHash };
    } else {
      throw new Error(`Invalid decision: ${decision}. Expected "approve" or "reject".`);
    }
  }
}

export const bridgeIngestionService = new BridgeIngestionService();
