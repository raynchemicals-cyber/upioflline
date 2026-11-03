import { decrypt, hashCiphertext } from '../utils/crypto.js';
import { idempotencyService } from './idempotencyService.js';
import { settlementService } from './settlementService.js';
import { riskScoringService } from './riskScoringService.js';
import { FlaggedPayment } from '../models/FlaggedPayment.js';

export class BridgeIngestionService {
  constructor() {
    this.maxAgeSeconds = parseInt(process.env.PACKET_MAX_AGE_SECONDS || '86400', 10);
  }

  /**
   * Orchestrates the bridge ingestion pipeline:
   * 1. Hash ciphertext (SHA-256)
   * 2. Idempotency gate check
   * 3. Hybrid decryption & GCM auth tag validation
   * 4. Freshness window check (replay & future-dating protection)
   * 5. AI Fraud & Risk Scoring (Isolation Forest + heuristics)
   * 6. Atomic settlement or insertion into flagged_payments
   *
   * @param {object} packet MeshPacket { packetId, ttl, createdAt, ciphertext }
   * @param {string} bridgeNodeId Node ID of bridge node
   * @param {number} hopCount
   * @param {string[]} [relayNodes]
   * @returns {Promise<object>} IngestResult
   */
  async ingest(packet, bridgeNodeId = 'unknown', hopCount = 0, relayNodes = []) {
    try {
      if (!packet || !packet.ciphertext) {
        return {
          outcome: 'INVALID',
          packetHash: '?',
          reason: 'missing_ciphertext',
          transactionId: null,
        };
      }

      const packetHash = hashCiphertext(packet.getCiphertext ? packet.getCiphertext() : packet.ciphertext);

      // ---- 1. Idempotency Gate ----
      if (!idempotencyService.claim(packetHash)) {
        console.log(
          `DUPLICATE packet ${packetHash.substring(0, 12)}... from bridge ${bridgeNodeId} - dropped`
        );
        return {
          outcome: 'DUPLICATE_DROPPED',
          packetHash,
          reason: null,
          transactionId: null,
        };
      }

      // ---- 2. Decrypt & Tamper Check ----
      let instruction;
      try {
        instruction = decrypt(packet.ciphertext);
      } catch (err) {
        console.warn(
          `Decryption failed for packet ${packetHash.substring(0, 12)}...: ${err.message}`
        );
        // Penalize bridge/relay node for transmitting an invalid/tampered packet
        await riskScoringService.penalizeRelay(bridgeNodeId).catch(() => {});
        return {
          outcome: 'INVALID',
          packetHash,
          reason: 'decryption_failed',
          transactionId: null,
        };
      }

      // ---- 3. Freshness Check (Replay Protection) ----
      const signedAt = Number(instruction.signedAt) || 0;
      const ageSeconds = (Date.now() - signedAt) / 1000;

      if (ageSeconds > this.maxAgeSeconds) {
        console.warn(`Packet ${packetHash.substring(0, 12)}... too old (${ageSeconds}s), rejected`);
        return {
          outcome: 'INVALID',
          packetHash,
          reason: 'stale_packet',
          transactionId: null,
        };
      }

      if (ageSeconds < -300) {
        // Small clock-skew tolerance (up to 5 min into the future)
        console.warn(`Packet ${packetHash.substring(0, 12)}... future-dated, rejected`);
        return {
          outcome: 'INVALID',
          packetHash,
          reason: 'future_dated',
          transactionId: null,
        };
      }

      // ---- 4. AI Fraud & Risk Scoring ----
      const risk = await riskScoringService.evaluateRisk({
        instruction,
        hopCount,
        bridgeNodeId,
        relayNodes,
      });

      if (risk.isFlagged) {
        console.warn(
          `FLAGGED packet ${packetHash.substring(0, 12)}... with risk score ${risk.riskScore}: ${risk.contributingFactors.join('; ')}`
        );
        await FlaggedPayment.findOneAndUpdate(
          { packetHash },
          {
            packetId: packet.packetId,
            packetHash,
            ciphertext: packet.ciphertext,
            senderVpa: instruction.senderVpa,
            receiverVpa: instruction.receiverVpa,
            amount: instruction.amount,
            signedAt: new Date(instruction.signedAt),
            bridgeNodeId,
            hopCount,
            riskScore: risk.riskScore,
            contributingFactors: risk.contributingFactors,
            status: 'PENDING_REVIEW',
          },
          { upsert: true, new: true }
        );

        return {
          outcome: 'FLAGGED',
          packetHash,
          reason: 'risk_score_exceeded',
          transactionId: null,
          riskScore: risk.riskScore,
          contributingFactors: risk.contributingFactors,
        };
      }

      // ---- 5. Atomic Settlement ----
      const tx = await settlementService.settle(instruction, packetHash, bridgeNodeId, hopCount);

      // Reward relay node on successful verified delivery
      await riskScoringService.rewardRelay(bridgeNodeId).catch(() => {});

      return {
        outcome: tx.status === 'REJECTED' ? 'REJECTED' : 'SETTLED',
        packetHash,
        reason: tx.status === 'REJECTED' ? 'insufficient_balance' : null,
        transactionId: tx.id,
      };
    } catch (err) {
      console.error('Ingestion error:', err);
      return {
        outcome: 'INVALID',
        packetHash: '?',
        reason: `internal_error: ${err.message}`,
        transactionId: null,
      };
    }
  }

  /**
   * Reviews a flagged payment (human-in-the-loop review).
   *
   * @param {string} flaggedId Flagged payment MongoDB _id
   * @param {'approve'|'reject'} decision
   * @returns {Promise<object>}
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
      const tx = await settlementService.settle(
        instruction,
        flagged.packetHash,
        flagged.bridgeNodeId,
        flagged.hopCount
      );

      flagged.status = 'APPROVED';
      flagged.reviewedAt = new Date();
      flagged.reviewDecision = 'approve';
      await flagged.save();

      return {
        outcome: 'SETTLED',
        packetHash: flagged.packetHash,
        transactionId: tx.id,
      };
    } else if (decision === 'reject') {
      flagged.status = 'REJECTED';
      flagged.reviewedAt = new Date();
      flagged.reviewDecision = 'reject';
      await flagged.save();

      return {
        outcome: 'REJECTED',
        packetHash: flagged.packetHash,
      };
    } else {
      throw new Error(`Invalid decision: ${decision}. Expected "approve" or "reject".`);
    }
  }
}

export const bridgeIngestionService = new BridgeIngestionService();
