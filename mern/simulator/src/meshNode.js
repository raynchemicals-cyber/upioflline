/**
 * meshNode.js — Single node in the BT mesh, with configurable behaviour profile
 *
 * BEHAVIOUR PROFILES
 * ──────────────────
 * | Profile     | Default drop rate | Delay multiplier | Tamper rate |
 * |-------------|-------------------|-----------------|-------------|
 * | honest      | 0%                | 1×              | 0%          |
 * | unreliable  | 30% (override OK) | 2×              | 0%          |
 * | malicious   | 0%                | 1×              | 100%        |
 *
 * Backward compatibility: isRogue: true → behaviourProfile: 'malicious'
 *
 * All randomness is routed through the caller-supplied rng (Mulberry32 seeded
 * PRNG) so that shouldDrop() and shouldTamper() decisions are reproducible.
 * No Math.random() calls here.
 */

import { INITIAL_TRUST } from './trustManager.js';

/** Default parameters per behaviour profile. */
export const BEHAVIOUR_PROFILES = Object.freeze({
  honest:     { dropRate: 0.00, delayMultiplier: 1, tamperRate: 0.00 },
  unreliable: { dropRate: 0.30, delayMultiplier: 2, tamperRate: 0.00 },
  malicious:  { dropRate: 0.00, delayMultiplier: 1, tamperRate: 1.00 },
});

export class MeshNode {
  /**
   * @param {object} cfg
   * @param {string}  cfg.id
   * @param {string}  [cfg.label]
   * @param {boolean} [cfg.hasInternet=false]
   * @param {boolean} [cfg.isRogue=false]        Backward-compat → maps to 'malicious'
   * @param {'honest'|'unreliable'|'malicious'} [cfg.behaviourProfile]
   * @param {number}  [cfg.dropRate]             Per-node drop rate override
   * @param {number}  [cfg.x=0]
   * @param {number}  [cfg.y=0]
   */
  constructor({
    id,
    label,
    hasInternet = false,
    isRogue     = false,
    behaviourProfile,
    dropRate,
    x = 0,
    y = 0,
  }) {
    this.id          = id;
    this.label       = label || id;
    this.hasInternet = hasInternet;
    this.isRogue     = isRogue;
    this.x           = x;
    this.y           = y;
    this.peers       = new Set();
    this.packetCache = new Map(); // packetId → { packet, receivedAt }

    // Determine effective profile; isRogue: true → malicious for backward compat
    this.behaviourProfile = behaviourProfile
      ? behaviourProfile
      : isRogue
        ? 'malicious'
        : 'honest';

    const profileDefaults =
      BEHAVIOUR_PROFILES[this.behaviourProfile] || BEHAVIOUR_PROFILES.honest;

    // Allow per-node drop-rate override (e.g. density experiments)
    this.dropRate        = dropRate !== undefined ? dropRate : profileDefaults.dropRate;
    this.delayMultiplier = profileDefaults.delayMultiplier;
    this.tamperRate      = profileDefaults.tamperRate;

    /**
     * Local trust-score copy kept in sync by TrustManager after each
     * propagation. Used by _choosePeers() for routing decisions without
     * an extra map lookup on every hop.
     */
    this.trustScore = INITIAL_TRUST;
  }

  addPeer(peerId)    { this.peers.add(peerId); }
  removePeer(peerId) { this.peers.delete(peerId); }
  hasPacket(packetId){ return this.packetCache.has(packetId); }

  storePacket(packet, clockNow = 0) {
    this.packetCache.set(packet.packetId, {
      packet:     { ...packet },
      receivedAt: clockNow,
    });
  }

  getPackets() {
    return Array.from(this.packetCache.values()).map((v) => v.packet);
  }

  clear() { this.packetCache.clear(); }

  /**
   * Decides whether this node drops a forwarded packet.
   * Malicious nodes do NOT drop — they tamper instead.
   * All randomness goes through the caller-supplied rng.
   *
   * @param {() => number} rng  Seeded PRNG
   * @returns {boolean}
   */
  shouldDrop(rng) {
    if (this.behaviourProfile === 'malicious') return false;
    return this.dropRate > 0 && rng() < this.dropRate;
  }

  /**
   * Decides whether this node tampers with the relayed packet.
   * @param {() => number} rng  Seeded PRNG
   * @returns {boolean}
   */
  shouldTamper(rng) {
    return this.tamperRate > 0 && rng() < this.tamperRate;
  }
}
