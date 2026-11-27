/**
 * RelayNode.js — Mongoose schema for relay node trust tracking
 *
 * TRUST SCORE (trustScore, 0–100):
 *   EMA-smoothed score updated on every relay event.
 *   α = 0.15; initial value = 80.
 *
 * BACKWARD COMPATIBILITY:
 *   The legacy `reputation` field is kept and always set to Math.round(trustScore)
 *   so older code paths and tests that read `reputation` continue to work.
 *
 * CLASSIFICATION:
 *   HONEST      trustScore ≥ 70
 *   UNRELIABLE  40 ≤ trustScore < 70
 *   MALICIOUS   trustScore < 40
 */
import mongoose from 'mongoose';

const relayNodeSchema = new mongoose.Schema(
  {
    nodeId: {
      type:     String,
      required: true,
      unique:   true,
      index:    true,
    },

    // ── Trust score (EMA-smoothed, 0–100) ──────────────────────────────────
    trustScore: {
      type:    Number,
      default: 80,
      min:     0,
      max:     100,
    },

    // Classification derived from trustScore
    classification: {
      type:    String,
      enum:    ['HONEST', 'UNRELIABLE', 'MALICIOUS'],
      default: 'HONEST',
    },

    // ── Legacy reputation field (backward compat) ───────────────────────────
    // Always set to Math.round(trustScore); tests that read `reputation` pass.
    reputation: {
      type:    Number,
      default: 80,
      min:     0,
      max:     100,
    },

    // ── Counters ─────────────────────────────────────────────────────────────
    totalRelayed:  { type: Number, default: 0 },  // all packets handled
    invalidRelayed:{ type: Number, default: 0 },  // tampered or contaminated
    forwardedOk:   { type: Number, default: 0 },  // successfully forwarded / delivered
    drops:         { type: Number, default: 0 },  // packets this node dropped
    slowForwards:  { type: Number, default: 0 },  // packets forwarded slowly

    // ── Timestamp of most recent trust event ─────────────────────────────────
    lastEventAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

export const RelayNode = mongoose.model('RelayNode', relayNodeSchema);
