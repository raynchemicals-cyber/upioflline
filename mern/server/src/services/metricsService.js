/**
 * metricsService.js — Server-side traffic & security metrics aggregator.
 *
 * Tracks:
 *  - Ingested / settled payments
 *  - Rejections (tampered AEAD tags, stale timestamps, idempotency duplicates)
 *  - Hops, delay, transmissions overhead
 *  - SSE live-stream subscriber management
 */

export class MetricsService {
  constructor() {
    this.reset();
    this.subscribers = new Set();
  }

  reset() {
    this.counters = {
      sent: 0,
      delivered: 0,
      dropped: 0,
      duplicates: 0,
      rejectedTampered: 0,
      rejectedStale: 0,
      transmissions: 0,
    };

    this.hops = {
      total: 0,
      count: 0,
      min: null,
      max: 0,
      mean: 0,
    };

    this.delay = {
      total: 0,
      count: 0,
      min: null,
      max: 0,
      mean: 0,
    };

    this.history = [];
    this.startTime = Date.now();
  }

  recordSent(count = 1) {
    this.counters.sent += count;
    this.counters.transmissions += count;
    this._recordHistory();
    this._notify();
  }

  recordDelivered({ hopCount = 0, delayMs = 0 } = {}) {
    this.counters.delivered += 1;

    // Hop stats
    this.hops.count += 1;
    this.hops.total += hopCount;
    this.hops.max = Math.max(this.hops.max, hopCount);
    this.hops.min = this.hops.min === null ? hopCount : Math.min(this.hops.min, hopCount);
    this.hops.mean = parseFloat((this.hops.total / this.hops.count).toFixed(2));

    // Delay stats
    if (delayMs >= 0) {
      this.delay.count += 1;
      this.delay.total += delayMs;
      this.delay.max = Math.max(this.delay.max, delayMs);
      this.delay.min = this.delay.min === null ? delayMs : Math.min(this.delay.min, delayMs);
      this.delay.mean = parseFloat((this.delay.total / this.delay.count).toFixed(2));
    }

    this._recordHistory();
    this._notify();
  }

  recordDropped(count = 1) {
    this.counters.dropped += count;
    this._recordHistory();
    this._notify();
  }

  recordDuplicate(count = 1) {
    this.counters.duplicates += count;
    this._recordHistory();
    this._notify();
  }

  recordTampered(count = 1) {
    this.counters.rejectedTampered += count;
    this._recordHistory();
    this._notify();
  }

  recordStale(count = 1) {
    this.counters.rejectedStale += count;
    this._recordHistory();
    this._notify();
  }

  recordHop(hopCount = 1) {
    this.counters.transmissions += 1;
    this._recordHistory();
    this._notify();
  }

  getOverhead() {
    if (this.counters.delivered === 0) {
      return this.counters.transmissions;
    }
    return parseFloat((this.counters.transmissions / this.counters.delivered).toFixed(2));
  }

  getDeliveryRate() {
    if (this.counters.sent === 0) return 0;
    return parseFloat((this.counters.delivered / this.counters.sent).toFixed(3));
  }

  getSnapshot() {
    return {
      timestamp: Date.now(),
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      counters: { ...this.counters },
      hopStats: { ...this.hops },
      delayStats: { ...this.delay },
      overhead: this.getOverhead(),
      deliveryRate: this.getDeliveryRate(),
      history: this.history.slice(-30),
    };
  }

  _recordHistory() {
    const point = {
      t: Date.now(),
      sent: this.counters.sent,
      delivered: this.counters.delivered,
      dropped: this.counters.dropped,
      duplicates: this.counters.duplicates,
      tampered: this.counters.rejectedTampered,
      stale: this.counters.rejectedStale,
      overhead: this.getOverhead(),
    };
    this.history.push(point);
    if (this.history.length > 200) {
      this.history.shift();
    }
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  _notify() {
    const snapshot = this.getSnapshot();
    for (const sub of this.subscribers) {
      try {
        sub(snapshot);
      } catch {}
    }
  }
}

export const metricsService = new MetricsService();
