/**
 * In-memory idempotency cache mimicking Redis SETNX with TTL.
 *
 * Contract:
 *  - claim(packetHash) returns true on first call, false on any subsequent call within TTL
 *  - atomic in Node event loop
 *  - scheduled cleanup evicts entries exceeding TTL
 */
export class IdempotencyService {
  constructor(ttlSeconds = 86400) {
    this.seen = new Map();
    this.ttlMs = ttlSeconds * 1000;
    this.timer = setInterval(() => this.evictExpired(), 60000);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Try to claim a packet hash.
   * Returns true if first claimer; false if already claimed.
   * @param {string} packetHash
   * @returns {boolean}
   */
  claim(packetHash) {
    const now = Date.now();
    if (this.seen.has(packetHash)) {
      return false;
    }
    this.seen.set(packetHash, now);
    return true;
  }

  size() {
    return this.seen.size;
  }

  evictExpired() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [hash, timestamp] of this.seen.entries()) {
      if (timestamp < cutoff) {
        this.seen.delete(hash);
      }
    }
  }

  clear() {
    this.seen.clear();
  }

  destroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}

export const idempotencyService = new IdempotencyService(
  parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400', 10)
);
