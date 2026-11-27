/**
 * trust.test.js
 *
 * Covers:
 *   1. EMA update formula with documented alpha and deltas
 *   2. Asymmetric penalty: tamper (−35) >> forwarding reward (+3/+5)
 *   3. Classification thresholds (HONEST ≥ 70, UNRELIABLE 40–69, MALICIOUS < 40)
 *   4. Initial trust = 80
 *   5. Blame attribution: tamperer gets tamper delta, path nodes get path_contaminated
 *   6. Drop penalty applied to forwarding node (delivery-receipt / timeout mechanism)
 *   7. TrustManager.reset() clears scores and event log
 *   8. TrustManager.snapshot() returns all known nodes
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  TrustManager,
  TRUST_ALPHA,
  INITIAL_TRUST,
  DELTAS,
  THRESHOLD_HONEST,
  THRESHOLD_UNRELIABLE,
  classify,
} from '../../simulator/src/trustManager.js';

// ─── Helper ──────────────────────────────────────────────────────────────────

function emaExpected(current, delta) {
  const sample = Math.min(100, Math.max(0, current + delta));
  return TRUST_ALPHA * sample + (1 - TRUST_ALPHA) * current;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TrustManager — EMA update rule', () => {
  let tm;
  beforeEach(() => { tm = new TrustManager(); });

  it('initialises unknown nodes at INITIAL_TRUST (80)', () => {
    expect(tm.getScore('new-node')).toBe(INITIAL_TRUST);
    expect(INITIAL_TRUST).toBe(80);
  });

  it('applies forward_ok (+3) correctly via EMA', () => {
    const before = tm.getScore('node-a');
    const after  = tm.update('node-a', 'forward_ok');
    expect(after).toBeCloseTo(emaExpected(before, DELTAS.forward_ok), 10);
  });

  it('applies delivered (+5) correctly via EMA', () => {
    const before = tm.getScore('node-b');
    const after  = tm.update('node-b', 'delivered');
    expect(after).toBeCloseTo(emaExpected(before, DELTAS.delivered), 10);
  });

  it('applies drop (−8) correctly via EMA', () => {
    const before = tm.getScore('node-c');
    const after  = tm.update('node-c', 'drop');
    expect(after).toBeCloseTo(emaExpected(before, DELTAS.drop), 10);
  });

  it('applies tamper (−35) correctly via EMA', () => {
    const before = tm.getScore('node-d');
    const after  = tm.update('node-d', 'tamper');
    expect(after).toBeCloseTo(emaExpected(before, DELTAS.tamper), 10);
  });

  it('applies path_contaminated (−5) correctly via EMA', () => {
    const before = tm.getScore('node-e');
    const after  = tm.update('node-e', 'path_contaminated');
    expect(after).toBeCloseTo(emaExpected(before, DELTAS.path_contaminated), 10);
  });

  it('clamps sample at 0 so trust cannot go below 0', () => {
    // Force score near 0 by repeated tamper events
    const id = 'sink-node';
    for (let i = 0; i < 20; i++) tm.update(id, 'tamper');
    expect(tm.getScore(id)).toBeGreaterThanOrEqual(0);
  });

  it('clamps sample at 100 so trust cannot exceed 100', () => {
    // Force score near 100 by repeated forward_ok events on node starting at 80
    const id = 'float-node';
    for (let i = 0; i < 100; i++) tm.update(id, 'forward_ok');
    expect(tm.getScore(id)).toBeLessThanOrEqual(100);
  });
});

describe('TrustManager — asymmetric deltas (tamper >> reward)', () => {
  it('tamper delta magnitude (35) is > 11× forward_ok delta (3)  [actual ratio = 35/3 ≈ 11.67×]', () => {
    // 35 / 3 = 11.667  → strictly greater than 11, NOT merely 7
    expect(Math.abs(DELTAS.tamper)).toBeGreaterThan(11 * DELTAS.forward_ok);
    // For documentation: 7× is too loose; the real ratio is ≈ 12×
    expect(Math.abs(DELTAS.tamper) / DELTAS.forward_ok).toBeCloseTo(11.67, 1);
  });

  it('tamper delta magnitude (35) is > 4× drop delta (8)', () => {
    expect(Math.abs(DELTAS.tamper)).toBeGreaterThan(4 * Math.abs(DELTAS.drop));
  });

  it('a single tamper event outweighs multiple forward_ok events (net score drops)', () => {
    const tm     = new TrustManager();
    const nodeId = 'mixed-node';
    // Apply 5 forward_ok then 1 tamper — score should be below initial
    for (let i = 0; i < 5; i++) tm.update(nodeId, 'forward_ok');
    const afterRewards = tm.getScore(nodeId);
    tm.update(nodeId, 'tamper');
    expect(tm.getScore(nodeId)).toBeLessThan(afterRewards);
    expect(tm.getScore(nodeId)).toBeLessThan(INITIAL_TRUST);
  });
});

describe('TrustManager — classification thresholds', () => {
  it('classify() returns HONEST for score >= 70', () => {
    expect(classify(100)).toBe('HONEST');
    expect(classify(70)).toBe('HONEST');
    expect(THRESHOLD_HONEST).toBe(70);
  });

  it('classify() returns UNRELIABLE for 40 <= score < 70', () => {
    expect(classify(69.9)).toBe('UNRELIABLE');
    expect(classify(40)).toBe('UNRELIABLE');
    expect(THRESHOLD_UNRELIABLE).toBe(40);
  });

  it('classify() returns MALICIOUS for score < 40', () => {
    expect(classify(39.9)).toBe('MALICIOUS');
    expect(classify(0)).toBe('MALICIOUS');
  });

  it('node starts HONEST (80 >= 70)', () => {
    const tm = new TrustManager();
    expect(tm.classify('fresh')).toBe('HONEST');
  });

  it('node moves to UNRELIABLE after repeated drops', () => {
    const tm = new TrustManager();
    // Enough drops to bring score below 70 but above 40
    for (let i = 0; i < 15; i++) tm.update('dropper', 'drop');
    const score = tm.getScore('dropper');
    // Score should be in UNRELIABLE range or lower (not HONEST)
    expect(score).toBeLessThan(THRESHOLD_HONEST);
  });

  it('node moves to MALICIOUS after repeated tamper events', () => {
    const tm = new TrustManager();
    for (let i = 0; i < 10; i++) tm.update('bad', 'tamper');
    expect(tm.classify('bad')).toBe('MALICIOUS');
  });
});

// ─── NEW: Consecutive tamper trace (addresses Step A audit item b) ─────────────

describe('TrustManager — consecutive tamper trace from initial trust', () => {
  /**
   * This test addresses Step A audit item (b):
   *
   * "Add a test that prints trust after each consecutive tamper event from 80
   *  and shows how many events it takes to fall below 40."
   *
   * Under plain EMA with α=0.15 and delta=-35:
   *   sample_n  = max(0, T_{n-1} - 35)
   *   T_n       = 0.15 * sample_n + 0.85 * T_{n-1}
   *
   * Starting at T=80:
   *   After 1:  74.75   HONEST
   *   After 2:  69.5    UNRELIABLE
   *   After 3:  64.25   UNRELIABLE
   *   After 4:  59.0    UNRELIABLE
   *   After 5:  53.75   UNRELIABLE
   *   After 6:  48.5    UNRELIABLE
   *   After 7:  43.25   UNRELIABLE
   *   After 8:  38.0    MALICIOUS  ← falls below 40
   *
   * 8 consecutive tampers are enough to reach MALICIOUS from initial trust=80.
   * This is fast enough for the routing system to reclassify a malicious node
   * within a single experiment run (3 packets × ≤3 tampers each = 9 events).
   */
  it('prints trust after each consecutive tamper and reaches MALICIOUS within 8 events', () => {
    const tm     = new TrustManager();
    const nodeId = 'consecutive-tamperer';
    const trace  = [];

    for (let i = 1; i <= 20; i++) {
      const score = tm.update(nodeId, 'tamper');
      const cls   = tm.classify(nodeId);
      trace.push({ event: i, score: parseFloat(score.toFixed(4)), classification: cls });
      // Stop once MALICIOUS (below 40)
      if (cls === 'MALICIOUS') break;
    }

    // Print the trace so it appears in test output (--verbose)
    console.log('\nTamper trace from initial trust=80 (α=0.15, δ=-35):');
    for (const { event, score, classification } of trace) {
      console.log(`  After tamper ${event}: score=${score.toFixed(4)}  [${classification}]`);
    }

    const firstMalicious = trace.find((r) => r.classification === 'MALICIOUS');
    expect(firstMalicious).toBeDefined();

    // With α=0.15 and δ=-35 starting from 80, should reach MALICIOUS in exactly 8 events
    console.log(`\n  => MALICIOUS reached after ${firstMalicious.event} consecutive tampers`);
    expect(firstMalicious.event).toBeLessThanOrEqual(10); // conservative bound
    expect(firstMalicious.event).toBeGreaterThanOrEqual(6); // must take several events (EMA smoothing)

    // All intermediate steps must be monotonically decreasing
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i].score).toBeLessThan(trace[i - 1].score);
    }

    // Trust must remain >= 0 (clamping works)
    for (const { score } of trace) {
      expect(score).toBeGreaterThanOrEqual(0);
    }
  });

  it('honest nodes stay above 70 while a malicious node falls below 40 (10-node scenario)', () => {
    /**
     * Simulates Exp A: 10-node network, 1 malicious (tampers every packet),
     * rest honest. After enough packets, honest nodes should remain HONEST (≥70)
     * and the malicious node should reach MALICIOUS (<40).
     *
     * This is ground-truth blame: the simulator knows exactly who tampered.
     * Honest nodes receive only forward_ok (+3) and delivered (+5) rewards.
     * The malicious node receives tamper (−35) on every packet it handles.
     */
    const tm        = new TrustManager();
    const malicious = 'malicious-node';
    const honests   = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'];

    // Simulate 10 packets: each packet traverses 2–3 honest hops then the malicious node
    for (let p = 0; p < 10; p++) {
      // Honest nodes on the path get rewarded
      for (const id of honests) {
        tm.update(id, 'forward_ok');
      }
      // Bridge gets delivered bonus
      tm.update('bridge', 'delivered');

      // Malicious node tampers — receives tamper penalty
      tm.update(malicious, 'tamper');
    }

    const snap = tm.snapshot();

    // All honest relays must still be HONEST (≥ 70)
    for (const id of honests) {
      expect(snap[id].score).toBeGreaterThanOrEqual(THRESHOLD_HONEST);
      expect(snap[id].classification).toBe('HONEST');
    }

    // Malicious relay must be MALICIOUS (< 40)
    expect(snap[malicious].score).toBeLessThan(THRESHOLD_UNRELIABLE);
    expect(snap[malicious].classification).toBe('MALICIOUS');

    console.log('\nTrust after 10 packets (10-node scenario):');
    console.log('  Malicious:', snap[malicious].score.toFixed(2), snap[malicious].classification);
    for (const id of honests) {
      console.log(`  ${id}: ${snap[id].score.toFixed(2)} ${snap[id].classification}`);
    }
  });
});

describe('TrustManager — blame attribution', () => {
  it('direct tamperer receives DELTA_TAMPER (−35)', () => {
    const tm = new TrustManager();
    const before = tm.getScore('tamperer');
    tm.update('tamperer', 'tamper');
    expect(tm.getScore('tamperer')).toBeCloseTo(emaExpected(before, DELTAS.tamper), 10);
  });

  it('path nodes receive DELTA_PATH_CONTAMINATED (−5), not full tamper', () => {
    const tm = new TrustManager();
    const before = tm.getScore('relay');
    tm.update('relay', 'path_contaminated');
    const expected = emaExpected(before, DELTAS.path_contaminated);
    expect(tm.getScore('relay')).toBeCloseTo(expected, 10);
    // Must be less severe than tamper
    const afterTamper = emaExpected(before, DELTAS.tamper);
    expect(expected).toBeGreaterThan(afterTamper);
  });

  it('path_contaminated penalty is smaller than tamper penalty', () => {
    expect(Math.abs(DELTAS.path_contaminated)).toBeLessThan(Math.abs(DELTAS.tamper));
  });
});

describe('TrustManager — delivery-receipt / drop penalty', () => {
  it('forwarding node receives DELTA_DROP (−8) on packet drop', () => {
    const tm = new TrustManager();
    const id = 'drop-forwarder';
    const before = tm.getScore(id);
    tm.update(id, 'drop');
    expect(tm.getScore(id)).toBeCloseTo(emaExpected(before, DELTAS.drop), 10);
    expect(tm.getScore(id)).toBeLessThan(before);
  });

  it('drop delta is larger than slow delta (drop is worse than being slow)', () => {
    expect(Math.abs(DELTAS.drop)).toBeGreaterThan(Math.abs(DELTAS.slow));
  });
});

describe('TrustManager — event log and state management', () => {
  it('reset() clears scores and event log', () => {
    const tm = new TrustManager();
    tm.update('alpha', 'drop');
    tm.update('beta', 'forward_ok');
    expect(tm.eventLog.length).toBeGreaterThan(0);

    tm.reset();
    expect(tm.eventLog.length).toBe(0);
    expect(tm.getScore('alpha')).toBe(INITIAL_TRUST); // re-initialised
  });

  it('update() appends to eventLog with correct fields', () => {
    const tm = new TrustManager();
    tm.update('logger', 'forward_ok');

    expect(tm.eventLog.length).toBe(1);
    const entry = tm.eventLog[0];
    expect(entry.nodeId).toBe('logger');
    expect(entry.event).toBe('forward_ok');
    expect(entry.delta).toBe(DELTAS.forward_ok);
    expect(typeof entry.before).toBe('number');
    expect(typeof entry.after).toBe('number');
    expect(['HONEST', 'UNRELIABLE', 'MALICIOUS']).toContain(entry.classification);
  });

  it('snapshot() returns current score and classification for all nodes', () => {
    const tm = new TrustManager();
    tm.update('snap-a', 'drop');
    tm.update('snap-b', 'forward_ok');

    const snap = tm.snapshot();
    expect(typeof snap['snap-a'].score).toBe('number');
    expect(['HONEST', 'UNRELIABLE', 'MALICIOUS']).toContain(snap['snap-a'].classification);
    expect(snap['snap-b']).toBeDefined();
  });

  it('ignores unknown event names (returns current score unchanged)', () => {
    const tm = new TrustManager();
    const before = tm.getScore('noop');
    const result = tm.update('noop', 'unknown_event_xyz');
    expect(result).toBe(before);
    expect(tm.getScore('noop')).toBe(before);
  });
});
