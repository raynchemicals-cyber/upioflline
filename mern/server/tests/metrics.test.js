import { describe, it, expect, beforeEach } from '@jest/globals';
import { MetricsCollector } from '../../simulator/src/metricsCollector.js';
import { metricsService } from '../src/services/metricsService.js';

describe('Traffic and Security Metrics Suite', () => {
  let collector;

  beforeEach(() => {
    collector = new MetricsCollector();
    metricsService.reset();
  });

  it('initializes counters to zero', () => {
    const snap = collector.getSnapshot();
    expect(snap.counters.sent).toBe(0);
    expect(snap.counters.delivered).toBe(0);
    expect(snap.counters.dropped).toBe(0);
    expect(snap.counters.duplicates).toBe(0);
    expect(snap.counters.rejectedTampered).toBe(0);
    expect(snap.counters.rejectedStale).toBe(0);
    expect(snap.overhead).toBe(0);
    expect(snap.deliveryRate).toBe(0);
  });

  it('tracks sent, dropped, and duplicate events', () => {
    collector.recordSent(5);
    collector.recordDropped(2);
    collector.recordDuplicate(1);

    const snap = collector.getSnapshot();
    expect(snap.counters.sent).toBe(5);
    expect(snap.counters.dropped).toBe(2);
    expect(snap.counters.duplicates).toBe(1);
    expect(snap.counters.transmissions).toBe(5);
  });

  it('tracks security rejections (tampered and stale)', () => {
    collector.recordTampered(3);
    collector.recordStale(2);

    const snap = collector.getSnapshot();
    expect(snap.counters.rejectedTampered).toBe(3);
    expect(snap.counters.rejectedStale).toBe(2);
  });

  it('calculates hop and delay statistics correctly', () => {
    collector.recordDelivered({ hopCount: 2, delayMs: 100 });
    collector.recordDelivered({ hopCount: 4, delayMs: 200 });

    const snap = collector.getSnapshot();
    expect(snap.counters.delivered).toBe(2);
    expect(snap.hopStats.min).toBe(2);
    expect(snap.hopStats.max).toBe(4);
    expect(snap.hopStats.mean).toBe(3.0);
    expect(snap.delayStats.min).toBe(100);
    expect(snap.delayStats.max).toBe(200);
    expect(snap.delayStats.mean).toBe(150.0);
  });

  it('calculates transmission overhead and delivery rate', () => {
    collector.recordSent(4);
    collector.recordHop(1);
    collector.recordHop(1);
    collector.recordDelivered({ hopCount: 2, delayMs: 50 });
    collector.recordDelivered({ hopCount: 2, delayMs: 50 });

    // transmissions = 4 sent + 2 hops = 6; delivered = 2
    expect(collector.getOverhead()).toBe(3.0);
    expect(collector.getDeliveryRate()).toBe(0.5);
  });

  it('notifies subscribers on updates', () => {
    let notified = false;
    const unsub = collector.subscribe((s) => {
      notified = true;
    });

    collector.recordSent(1);
    expect(notified).toBe(true);
    unsub();
  });

  it('server metricsService singleton functions identically', () => {
    metricsService.recordSent(2);
    metricsService.recordDelivered({ hopCount: 3, delayMs: 120 });
    const snap = metricsService.getSnapshot();
    expect(snap.counters.sent).toBe(2);
    expect(snap.counters.delivered).toBe(1);
    expect(snap.hopStats.mean).toBe(3);
  });
});
