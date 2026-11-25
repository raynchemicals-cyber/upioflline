/**
 * experiments.js — Deterministic experiment harness for the UPI Offline Mesh
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * EXPERIMENT MATRIX
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  ID │ Name                   │ Variable                        │ Runs
 * ────┼────────────────────────┼─────────────────────────────────┼─────
 *  a  │ Trust evolution        │ 1 malicious + 2 unreliable mix  │  5
 *  b  │ Flood vs trust-aware   │ Routing mode (same topology)    │  5
 *  c  │ Drop rate sweep        │ 0 / 10 / 30 / 50 %             │  5
 *  d  │ Density sweep          │ 5 / 10 / 20 / 30 nodes         │  5
 *  e  │ Security rejections    │ Tamper / replay / duplicate     │  5
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * REPRODUCIBILITY
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Every run uses seed = runIndex * 1000 + expIndex (expIndex: a=0, b=1, …, e=4).
 * All randomness — drops, tampers, topology shuffles, ε-greedy exploration —
 * flows through the same createSeededRng(seed) instance. No Math.random().
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * SIMULATED TIME
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * useRealTime=false in all experiment runs. Delay metrics come from the
 * SimulatedClock (clock.now) rather than Date.now(). Each run resets the clock.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * FRAUD SCORER
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Uses trustScore (not legacy reputation). The in-process FraudScorer reads
 * trust directly from TrustManager — no server round-trip needed in experiments.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * OUTPUT
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Results are written to simulator/results/<expId>.json and printed to stdout.
 * Run with: npm run experiments
 */

import fs           from 'node:fs';
import path         from 'node:path';
import crypto       from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { MeshNode }        from './meshNode.js';
import { MeshNetwork }     from './meshNetwork.js';
import { TrustManager,
         INITIAL_TRUST,
         THRESHOLD_HONEST,
         THRESHOLD_UNRELIABLE } from './trustManager.js';
import { SimulatedClock }  from './simulatedClock.js';
import { createSeededRng } from './seededRandom.js';

// ─── Output directory ────────────────────────────────────────────────────────

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, '..', 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ─── Constants ───────────────────────────────────────────────────────────────

const RUNS_PER_EXP  = 5;
const HOP_DELAY_MS  = 300;    // simulated ms per hop (MeshNetwork default)
const MAX_HOPS      = 5;

// Experiment indices (used in seed formula: seed = runIndex * 1000 + expIndex)
const EXP_IDX = { a: 0, b: 1, c: 2, d: 3, e: 4 };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal but reproducible payment packet without hitting a real server.
 * Ciphertext is a random base64 blob of proper minimum length (≥ 300 bytes) so
 * tamper detection logic (bit-flip byte at mid-point) works correctly.
 *
 * @param {() => number} rng  Seeded PRNG
 */
function makePacket(rng) {
  // 300 bytes of deterministic pseudo-random bytes as the ciphertext
  const buf = Buffer.allocUnsafe(300);
  for (let i = 0; i < 300; i++) {
    buf[i] = Math.floor(rng() * 256);
  }
  return {
    packetId:   crypto.randomUUID(),   // UUID uses OS randomness — fine for IDs
    ttl:        MAX_HOPS,
    createdAt:  0,
    ciphertext: buf.toString('base64'),
  };
}

/**
 * Build a star-of-stars topology with the requested number of nodes.
 * Bridges (nodes with hasInternet) are placed at regular intervals.
 *
 * @param {number} nodeCount   Total nodes including bridges
 * @param {string[]} profiles  Behaviour profile per relay node ('honest'|'unreliable'|'malicious')
 * @param {number} dropRate    Per-node drop rate for the 'unreliable'-equivalent
 * @param {(() => number)|null} [rng]  When set, redundant edges are drawn from this
 *   PRNG so each seed yields a different graph. Omitted → the historical fixed
 *   cross-links (experiments A–E stay reproducible).
 * @returns {{ nodes: MeshNode[], edges: [string,string][] }}
 */
function buildTopology(nodeCount, profiles = [], dropRate = 0, rng = null) {
  const nodes = [];
  const edges = [];

  // Source node (the paying device)
  const source = new MeshNode({ id: 'src', label: 'Source', x: 0, y: 0 });
  nodes.push(source);

  // Bridge node(s): every 1 in 5 devices has internet
  const bridgeInterval = Math.max(2, Math.floor(nodeCount / Math.max(1, Math.floor(nodeCount / 5))));
  const relayCount     = nodeCount - 1;

  for (let i = 0; i < relayCount; i++) {
    const hasInternet =
      (i % bridgeInterval === bridgeInterval - 1) ||
      (i === relayCount - 1 && !nodes.some((n) => n.hasInternet));
    const profile         = profiles[i] || 'honest';
    const nodeDropRate    = profile === 'unreliable' ? (dropRate || 0.30) : 0;

    const node = new MeshNode({
      id:              `node-${i}`,
      label:           hasInternet ? `Bridge-${i}` : `Relay-${i}`,
      hasInternet,
      behaviourProfile: profile,
      dropRate:         nodeDropRate,
      x:               (i + 1) * 60,
      y:               (i % 3) * 80,
    });
    nodes.push(node);
  }

  // Simple chain topology: source → relay0 → relay1 → … → bridge
  // For larger topologies, add cross-links every 3rd node for redundancy.
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push([nodes[i].id, nodes[i + 1].id]);
  }
  // Cross-links for redundancy in topologies with ≥ 6 nodes.
  // Without an rng this is the historical every-3rd skip (A–E).
  // With an rng, each seed independently accepts skip-2 and skip-3 edges.
  if (!rng) {
    for (let i = 0; i + 3 < nodes.length; i += 3) {
      edges.push([nodes[i].id, nodes[i + 3].id]);
    }
  } else {
    for (let i = 0; i < nodes.length; i++) {
      for (const skip of [2, 3]) {
        const j = i + skip;
        if (j < nodes.length && rng() < 0.5) {
          edges.push([nodes[i].id, nodes[j].id]);
        }
      }
    }
  }

  return { nodes, edges };
}

/**
 * Wire a list of nodes and edges into a MeshNetwork.
 *
 * @param {object} opts
 * @param {MeshNode[]}     opts.nodes
 * @param {[string,string][]} opts.edges
 * @param {'flood'|'trust-aware'} opts.routingMode
 * @param {number}         opts.networkDropRate
 * @param {TrustManager}   opts.trustManager
 * @param {SimulatedClock} opts.clock
 * @param {() => number}   opts.rng
 * @returns {MeshNetwork}
 */
function wireNetwork({ nodes, edges, routingMode, networkDropRate, trustManager, clock, rng }) {
  const net = new MeshNetwork({
    dropRate:   networkDropRate,
    hopDelayMs: HOP_DELAY_MS,
    maxHops:    MAX_HOPS,
    routingMode,
    trustManager,
    clock,
    rng,
    useRealTime: false,
  });

  // Replace the default topology with ours
  net.nodes.clear();
  for (const n of nodes) {
    net.nodes.set(n.id, n);
  }
  for (const [a, b] of edges) {
    net.connect(a, b);
  }

  return net;
}

/**
 * Run one experiment trial: inject one packet and collect metrics.
 *
 * @param {MeshNetwork}    net
 * @param {SimulatedClock} clock
 * @param {() => number}   rng
 * @returns {Promise<object>} run metrics
 */
async function runTrial(net, clock, rng) {
  clock.reset(0);

  const events = {
    hops:        0,
    delivered:   0,
    dropped:     0,
    tampered:    0,
    fallbacks:   0,
    explores:    0,
  };

  const off = net.onEvent((e) => {
    if (e.type === 'PACKET_HOP')      events.hops++;
    if (e.type === 'BRIDGE_REACHED')  events.delivered++;
    if (e.type === 'PACKET_DROPPED')  events.dropped++;
    if (e.type === 'PACKET_TAMPERED') events.tampered++;
    if (e.type === 'ROUTING_FALLBACK') events.fallbacks++;
    if (e.type === 'ROUTING_EXPLORE')  events.explores++;
  });

  const packet    = makePacket(rng);
  const sourceId  = Array.from(net.nodes.keys())[0]; // first node = source
  const deliveries = await net.propagatePacket(sourceId, packet);

  off(); // remove listener

  const totalTransmissions = events.hops + 1; // +1 for injection
  const deliveryRate       = events.delivered > 0 ? 1 : 0;
  const overhead           = events.delivered > 0
    ? totalTransmissions / events.delivered
    : totalTransmissions;

  const deliveryTimeMs = deliveries.length > 0
    ? deliveries[0].deliveryTimeMs
    : null;

  return {
    delivered:       events.delivered,
    dropped:         events.dropped,
    tampered:        events.tampered,
    hops:            events.hops,
    deliveryRate,
    deliveryTimeMs,
    overhead,
    fallbacks:       events.fallbacks,
    explores:        events.explores,
    trustSnapshot:   net.trustManager.snapshot(),
  };
}

// ─── In-process fraud scorer ─────────────────────────────────────────────────

/**
 * Minimal fraud scorer that uses trust scores from TrustManager.
 * No server or MongoDB needed.
 *
 * Risk signals:
 *   - hopCount ≥ 7 → elevated
 *   - minTrust < 40 (MALICIOUS relay) → penalise
 *   - minTrust < 70 (UNRELIABLE relay) → partial penalise
 *
 * @param {{ hopCount: number, trustManager: TrustManager, relayIds: string[] }} opts
 * @returns {{ riskScore: number, isFlagged: boolean, minTrust: number, offendingNode: string|null }}
 */
function fraudScore({ hopCount, trustManager, relayIds }) {
  let score = 0;
  let minTrust = 100;
  let offendingNode = null;

  for (const id of relayIds) {
    const t = trustManager.getScore(id);
    if (t < minTrust) { minTrust = t; offendingNode = id; }
  }

  if (hopCount >= 7) score += 15;
  else if (hopCount >= 5) score += 9;

  if (minTrust < THRESHOLD_UNRELIABLE) {
    score += 20; // MALICIOUS
  } else if (minTrust < THRESHOLD_HONEST) {
    score += 12; // UNRELIABLE
  }

  return { riskScore: score, isFlagged: score >= 20, minTrust, offendingNode };
}

// ─── Experiment A: Trust Evolution ───────────────────────────────────────────

async function expA() {
  const expId = 'a';
  console.log('\n══ Exp A: Trust Evolution (1 malicious + 2 unreliable in honest network) ══');

  const results = [];

  for (let run = 0; run < RUNS_PER_EXP; run++) {
    const seed         = run * 1000 + EXP_IDX[expId];
    const rng          = createSeededRng(seed);
    const clock        = new SimulatedClock();
    const trustManager = new TrustManager();

    // 10-node network: idx 0=source, 1=malicious, 2=unreliable, 3=unreliable, rest honest
    const profiles = ['malicious', 'unreliable', 'unreliable', 'honest', 'honest', 'honest', 'honest', 'honest', 'honest'];
    const { nodes, edges } = buildTopology(10, profiles);

    const net = wireNetwork({ nodes, edges, routingMode: 'flood', networkDropRate: 0, trustManager, clock, rng });

    // Run 3 packets so trust evolves across multiple events
    const runResults = [];
    for (let p = 0; p < 3; p++) {
      const r = await runTrial(net, clock, rng);
      runResults.push(r);
    }

    const finalSnapshot = net.trustManager.snapshot();
    const fraud = fraudScore({
      hopCount:     runResults[runResults.length - 1].hops,
      trustManager: net.trustManager,
      relayIds:     nodes.filter((n) => !n.hasInternet && n.id !== 'src').map((n) => n.id),
    });

    results.push({
      seed,
      run,
      packets:        runResults.length,
      deliveries:     runResults.map((r) => r.delivered),
      finalSnapshot,
      fraud,
    });

    console.log(`  run ${run}: fraud isFlagged=${fraud.isFlagged} minTrust=${fraud.minTrust.toFixed(1)}`);
  }

  return results;
}

// ─── Experiment B: Flood vs Trust-Aware ──────────────────────────────────────

async function expB() {
  const expId = 'b';
  console.log('\n══ Exp B: Flood vs Trust-Aware Routing ══');

  const results = [];

  for (let run = 0; run < RUNS_PER_EXP; run++) {
    const seed = run * 1000 + EXP_IDX[expId];

    const runRow = { seed, run, flood: null, trustAware: null };

    for (const mode of ['flood', 'trust-aware']) {
      const rng          = createSeededRng(seed);
      const clock        = new SimulatedClock();
      const trustManager = new TrustManager();

      // Mixed topology: 1 malicious among 9 honest in 10 nodes
      const profiles = ['malicious', 'honest', 'honest', 'honest', 'honest', 'honest', 'honest', 'honest', 'honest'];
      const { nodes, edges } = buildTopology(10, profiles);

      const net = wireNetwork({ nodes, edges, routingMode: mode, networkDropRate: 0.05, trustManager, clock, rng });

      const r = await runTrial(net, clock, rng);
      runRow[mode === 'flood' ? 'flood' : 'trustAware'] = {
        deliveryRate:  r.deliveryRate,
        delivered:     r.delivered,
        dropped:       r.dropped,
        tampered:      r.tampered,
        overhead:      r.overhead,
        deliveryTimeMs: r.deliveryTimeMs,
        fallbacks:     r.fallbacks,
        explores:      r.explores,
      };
    }

    results.push(runRow);
    console.log(`  run ${run}: flood delivered=${runRow.flood.delivered} trust-aware delivered=${runRow.trustAware.delivered}`);
  }

  return results;
}

// ─── Experiment C: Drop Rate Sweep ───────────────────────────────────────────

async function expC() {
  const expId = 'c';
  console.log('\n══ Exp C: Drop Rate Sweep (0 / 10 / 30 / 50 %) ══');

  const dropRates = [0, 0.10, 0.30, 0.50];
  const results   = [];

  for (const dropRate of dropRates) {
    const dropResults = [];

    for (let run = 0; run < RUNS_PER_EXP; run++) {
      const seed         = run * 1000 + EXP_IDX[expId];
      const rng          = createSeededRng(seed);
      const clock        = new SimulatedClock();
      const trustManager = new TrustManager();

      const { nodes, edges } = buildTopology(10, []);
      const net = wireNetwork({ nodes, edges, routingMode: 'flood', networkDropRate: dropRate, trustManager, clock, rng });

      const r = await runTrial(net, clock, rng);
      dropResults.push({ seed, run, ...r, trustSnapshot: undefined });
    }

    const avgDelivery = dropResults.reduce((s, r) => s + r.deliveryRate, 0) / dropResults.length;
    const avgDropped  = dropResults.reduce((s, r) => s + r.dropped, 0)  / dropResults.length;

    console.log(`  dropRate=${(dropRate * 100).toFixed(0)}%  avgDeliveryRate=${avgDelivery.toFixed(2)}  avgDropped=${avgDropped.toFixed(1)}`);
    results.push({ dropRate, avgDeliveryRate: avgDelivery, avgDropped, runs: dropResults });
  }

  return results;
}

// ─── Experiment D: Density Sweep ─────────────────────────────────────────────

async function expD() {
  const expId = 'd';
  console.log('\n══ Exp D: Density Sweep (5 / 10 / 20 / 30 nodes) ══');

  const densities = [5, 10, 20, 30];
  const results   = [];

  for (const nodeCount of densities) {
    const densityResults = [];

    for (let run = 0; run < RUNS_PER_EXP; run++) {
      const seed         = run * 1000 + EXP_IDX[expId];
      const rng          = createSeededRng(seed);
      const clock        = new SimulatedClock();
      const trustManager = new TrustManager();

      const { nodes, edges } = buildTopology(nodeCount, []);
      const net = wireNetwork({ nodes, edges, routingMode: 'flood', networkDropRate: 0.05, trustManager, clock, rng });

      const r = await runTrial(net, clock, rng);
      densityResults.push({ seed, run, nodes: nodeCount, ...r, trustSnapshot: undefined });
    }

    const avgDelivery = densityResults.reduce((s, r) => s + r.deliveryRate, 0) / densityResults.length;
    const avgHops     = densityResults.reduce((s, r) => s + r.hops, 0)         / densityResults.length;
    const avgTime     = densityResults.filter((r) => r.deliveryTimeMs !== null)
                                      .reduce((s, r) => s + r.deliveryTimeMs, 0)
                        / Math.max(1, densityResults.filter((r) => r.deliveryTimeMs !== null).length);

    console.log(`  nodes=${nodeCount}  avgDeliveryRate=${avgDelivery.toFixed(2)}  avgHops=${avgHops.toFixed(1)}  avgTimeMs=${avgTime.toFixed(0)}`);
    results.push({ nodeCount, avgDeliveryRate: avgDelivery, avgHops, avgDeliveryTimeMs: avgTime, runs: densityResults });
  }

  return results;
}

// ─── Experiment E: Security Rejections ───────────────────────────────────────

/**
 * Tests three security scenarios, each run RUNS_PER_EXP times:
 *
 *  1. Tamper:    malicious node flips a byte; tamper event count > 0
 *  2. Replay:    fresh packet re-injected a 2nd time; packet stored in cache → 0 hops
 *  3. Duplicate: same packet injected at two separate source nodes; second reaches bridge
 *               but idempotency would reject it at the server layer. We verify the
 *               simulator emits a BRIDGE_REACHED for both paths.
 *
 * The in-process fraud scorer uses trust scores: after a tamper is detected, the
 * malicious relay should be classified MALICIOUS and isFlagged=true.
 */
async function expE() {
  const expId = 'e';
  console.log('\n══ Exp E: Security Rejections (tamper / replay / duplicate) ══');

  const results = { tamper: [], replay: [], duplicate: [] };

  for (let run = 0; run < RUNS_PER_EXP; run++) {
    const seed = run * 1000 + EXP_IDX[expId];

    // ── 1. Tamper rejection ────────────────────────────────────────────────────
    {
      const rng          = createSeededRng(seed);
      const clock        = new SimulatedClock();
      const trustManager = new TrustManager();

      const profiles = ['malicious', 'honest', 'honest', 'honest', 'honest', 'honest', 'honest', 'honest', 'honest'];
      const { nodes, edges } = buildTopology(10, profiles);
      const net = wireNetwork({ nodes, edges, routingMode: 'flood', networkDropRate: 0, trustManager, clock, rng });

      let tamperedCount = 0;
      net.onEvent((e) => { if (e.type === 'PACKET_TAMPERED') tamperedCount++; });

      const packet = makePacket(rng);
      await net.propagatePacket('src', packet);

      const relayIds = nodes.filter((n) => !n.hasInternet && n.id !== 'src').map((n) => n.id);
      const fraud = fraudScore({ hopCount: 3, trustManager, relayIds });

      results.tamper.push({ seed, run, tamperedCount, fraud });
      console.log(`  run ${run} tamper: tamperedCount=${tamperedCount} isFlagged=${fraud.isFlagged}`);
    }

    // ── 2. Replay detection ────────────────────────────────────────────────────
    {
      const rng          = createSeededRng(seed);
      const clock        = new SimulatedClock();
      const trustManager = new TrustManager();

      const { nodes, edges } = buildTopology(10, []);
      const net = wireNetwork({ nodes, edges, routingMode: 'flood', networkDropRate: 0, trustManager, clock, rng });

      const packet = makePacket(rng);

      // First injection — normal
      const d1 = await net.propagatePacket('src', packet);

      // Second injection of same packetId — nodes already have it in cache.
      // BFS skips peers for cached packets in a re-entry scenario.
      // We simulate replay by checking cache: nodes that already cached the packet
      // will not re-queue it (hasPacket() guard).
      let hopsOnReplay = 0;
      net.onEvent((e) => { if (e.type === 'PACKET_HOP') hopsOnReplay++; });

      // Re-inject: meshNode.storePacket allows overwriting (no guard there),
      // but _choosePeers excludes already-visited — here path starts fresh.
      // The key replay protection is at the SERVER layer (idempotency).
      // At the simulator layer we verify that the second propagation returns deliveries.
      const d2 = await net.propagatePacket('src', packet);

      results.replay.push({
        seed, run,
        firstDeliveries:  d1.length,
        replayDeliveries: d2.length,
        replayBlocked: d2.length === 0, // true if replay was fully blocked at mesh layer
      });
      console.log(`  run ${run} replay: firstDeliveries=${d1.length} replayDeliveries=${d2.length}`);
    }

    // ── 3. Duplicate packet from two source nodes ─────────────────────────────
    {
      const rng          = createSeededRng(seed);
      const clock        = new SimulatedClock();
      const trustManager = new TrustManager();

      const { nodes, edges } = buildTopology(10, []);
      const net = wireNetwork({ nodes, edges, routingMode: 'flood', networkDropRate: 0, trustManager, clock, rng });

      const packet = makePacket(rng);

      // Inject from two different sources concurrently
      const [dA, dB] = await Promise.all([
        net.propagatePacket('src', packet),
        // Use a second source node if available
        nodes.length > 2
          ? net.propagatePacket(nodes[1].id, { ...packet, packetId: packet.packetId })
          : Promise.resolve([]),
      ]);

      results.duplicate.push({
        seed, run,
        deliveriesFromSrc1: dA.length,
        deliveriesFromSrc2: dB.length,
        // Both paths may reach the bridge; server idempotency rejects duplicates.
        bothReached: dA.length > 0 && dB.length > 0,
      });
      console.log(`  run ${run} duplicate: src1=${dA.length} src2=${dB.length} bothReached=${dA.length > 0 && dB.length > 0}`);
    }
  }

  return results;
}

// ─── Experiment F: Oracle-Free Blame Attribution ──────────────────────────────
//
// A2 requirement (item 4): run a variant WITHOUT the ground-truth oracle.
//
// In the standard experiments the simulator knows exactly which node tampered
// (behaviourProfile === 'malicious') and applies the full DELTA_TAMPER (−35)
// directly to that node. This is documented as a shortcut in README "What's
// not real".
//
// Here we implement the alternative: when a packet is detected as tampered
// (BRIDGE_REACHED fires with a corrupted ciphertext, OR the tamper event fires)
// we penalise EVERY relay on the path EQUALLY with DELTA_PATH_CONTAMINATED (−5).
// No node gets the full tamper penalty; blame is shared uniformly.
//
// Hypothesis: even with equal blame, the malicious node will accumulate more
// penalties over time (because it tampers every packet it sees) while honest
// nodes accumulate mostly positive forward_ok (+3) rewards. After enough packets
// the malicious node's score should still separate below the honest cluster.
//
// Network: 10 nodes, 1 malicious (idx 0), rest honest.
// Packets: 20 per run (more than exp A's 3 — needed to accumulate signal).
// Metric:  final trust scores; does malicious node score < any honest node?
//
// Blame rule: on PACKET_TAMPERED event, apply path_contaminated (−5) to EVERY
// relay on the path recorded in the event (from path[]).

async function expF() {
  const expId = 'f';
  console.log('\n══ Exp F: Oracle-Free Blame (uniform path penalty, 10 nodes, 1 malicious, 200 pkts) ══');

  const results = [];
  const PACKETS_PER_RUN = 200;

  for (let run = 0; run < RUNS_PER_EXP; run++) {
    const seed         = run * 1000 + 5; // distinct seed per run
    const rng          = createSeededRng(seed);
    const clock        = new SimulatedClock();
    const trustManager = new TrustManager();

    // 1 malicious node at index 0, rest honest
    const profiles = ['malicious', 'honest', 'honest', 'honest', 'honest',
                      'honest', 'honest', 'honest', 'honest'];
    // Topology must consume this run's rng. Previously buildTopology ignored
    // the seed, so runs 0–4 (seeds 5, 1005, …) walked one identical graph and
    // flood+dropRate 0 produced identical scores.
    const { nodes, edges } = buildTopology(10, profiles, 0, rng);
    const edgeList = edges.map(([a, b]) => `${a}--${b}`);

    const net = wireNetwork({
      nodes, edges,
      routingMode:     'flood',
      networkDropRate: 0,
      trustManager,
      clock,
      rng,
    });

    const maliciousId = nodes.find((n) => n.behaviourProfile === 'malicious')?.id;
    const honestIds   = nodes
      .filter((n) => n.behaviourProfile === 'honest' && !n.hasInternet && n.id !== 'src')
      .map((n) => n.id);

    // ── Oracle-free blame: monkey-patch _applyTrustUpdates ──────────────────
    // End-to-end verification check:
    // 1. Credit forward_ok ONLY when a packet verifies end-to-end (ciphertext matches).
    // 2. On failed verification, penalise ALL relays on the path equally with path_contaminated (-5).
    //    NO ground-truth identification of the rogue node; NO forward_ok for corrupt packets.
    net._applyTrustUpdates = function(sourceId, bridgeDeliveries, droppedHops, tamperedNodes, originalCiphertext) {
      for (const d of bridgeDeliveries) {
        const isVerified = (originalCiphertext != null && d.packet.ciphertext === originalCiphertext);
        if (isVerified) {
          for (const nodeId of d.path) {
            if (nodeId === sourceId) continue;
            trustManager.update(nodeId, 'forward_ok');
          }
          trustManager.update(d.bridgeId, 'delivered');
        } else {
          // Failed end-to-end verification: uniform penalty on all relays along the contaminated path
          for (const nodeId of d.path) {
            if (nodeId === sourceId) continue;
            trustManager.update(nodeId, 'path_contaminated');
          }
        }
      }

      // Penalize drops normally
      const penalizedForDrops = new Set();
      for (const { from } of droppedHops) {
        if (!penalizedForDrops.has(from)) {
          trustManager.update(from, 'drop');
          penalizedForDrops.add(from);
        }
      }

      // Sync trustScore back into MeshNode for routing decisions
      for (const [id, node] of net.nodes.entries()) {
        node.trustScore = trustManager.getScore(id);
      }
    };

    // Run 200 packets per run originating from source node 'src'.
    // Flood + dropRate 0 is deterministic given the graph, so packet 0's
    // delivery paths are the paths used for the whole run.
    const pathSample = [];
    const offPaths = net.onEvent((e) => {
      if (e.type === 'BRIDGE_REACHED') pathSample.push(e.path.join('>'));
    });
    for (let p = 0; p < PACKETS_PER_RUN; p++) {
      clock.reset(0);
      const packet = makePacket(rng);
      await net.propagatePacket('src', packet);
      if (p === 0) offPaths();
    }
    const uniquePaths = [...new Set(pathSample)];
    const usedOnPath = new Set(uniquePaths.flatMap((p) => p.split('>')));
    const neverOnDelivery = nodes
      .map((n) => n.id)
      .filter((id) => id !== 'src' && !usedOnPath.has(id));

    if (run === 0) {
      console.log(`  seed ${seed} topology (${edgeList.length} edges):`);
      console.log(`    ${edgeList.join(', ')}`);
      console.log(`  delivery paths (packet 0, ${uniquePaths.length} unique):`);
      for (const pth of uniquePaths) console.log(`    ${pth}`);
      console.log(
        `  never on a delivery path (stay at init ${INITIAL_TRUST}): ` +
        (neverOnDelivery.join(', ') || '(none)')
      );
    }

    const snap           = trustManager.snapshot();
    const maliciousScore = snap[maliciousId]?.score ?? INITIAL_TRUST;
    const honestScores   = honestIds
      .filter((id) => snap[id])
      .map((id) => snap[id].score);

    const minHonest = honestScores.length > 0 ? Math.min(...honestScores) : INITIAL_TRUST;
    const separated = maliciousScore < minHonest;

    const perNodeTable = Object.fromEntries(
      nodes.map((n) => [
        n.id,
        {
          label: n.label,
          profile: n.behaviourProfile,
          hasInternet: n.hasInternet,
          score: parseFloat((snap[n.id]?.score ?? INITIAL_TRUST).toFixed(2)),
          classification: snap[n.id]?.classification ?? 'HONEST',
        },
      ])
    );

    if (run === 0) {
      console.log('\n  Per-node trust table for Run 0:');
      console.log('  -------------------------------------------------------------');
      console.log('  Node ID   | Profile   | Internet | Trust Score | Classification');
      console.log('  -------------------------------------------------------------');
      for (const [id, info] of Object.entries(perNodeTable)) {
        console.log(
          `  ${id.padEnd(9)} | ${info.profile.padEnd(9)} | ${String(info.hasInternet).padEnd(8)} | ` +
          `${info.score.toFixed(2).padStart(11)} | ${info.classification}`
        );
      }
      console.log('  -------------------------------------------------------------');
    }

    results.push({
      seed,
      run,
      maliciousId,
      maliciousScore: parseFloat(maliciousScore.toFixed(3)),
      minHonestScore: parseFloat(minHonest.toFixed(3)),
      separated,
      topologyEdges: edgeList,
      deliveryPaths: uniquePaths,
      neverOnDeliveryPath: neverOnDelivery,
      honestScores: Object.fromEntries(
        honestIds.map((id) => [id, parseFloat((snap[id]?.score ?? INITIAL_TRUST).toFixed(3))])
      ),
      perNodeTable,
    });

    console.log(
      `  run ${run} seed=${seed} edges=${edgeList.length}: malicious=${maliciousScore.toFixed(1)} ` +
      `minHonest=${minHonest.toFixed(1)} separated=${separated}`
    );
  }

  // Report separation rate honestly
  const sepCount = results.filter((r) => r.separated).length;
  console.log(`\n  Oracle-free blame: malicious separated from honest in ${sepCount}/${results.length} runs`);
  if (sepCount < results.length) {
    console.log(
      '  ⚠  Uniform path blame penalises every relay on a tampered delivery, including honest\n' +
      '     relays that only forwarded the tampered ciphertext. That is a false positive, not\n' +
      '     isolation of a contaminated branch.'
    );
  }

  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  UPI Offline Mesh — Experiment Harness');
  console.log('  All randomness seeded; simulated time; no Math.random()');
  console.log('═══════════════════════════════════════════════════════════════');

  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1] : null;
  const allResults = {};

  if (!only || only === 'a') allResults.a = await expA();
  if (!only || only === 'b') allResults.b = await expB();
  if (!only || only === 'c') allResults.c = await expC();
  if (!only || only === 'd') allResults.d = await expD();
  if (!only || only === 'e') allResults.e = await expE();
  if (!only || only === 'f') allResults.f = await expF();
  if (!only || only === 'g') {
    // expG is appended by later tasks; ignore unknown until it exists
    if (typeof expG === 'function') allResults.g = await expG();
  }

  // Write per-experiment JSON and CSV
  const csvFiles = {};

  if (allResults.a) {
    let csvA = 'run,seed,packets,minTrust,isFlagged,riskScore\n';
    for (const r of allResults.a) {
      csvA += `${r.run},${r.seed},${r.packets},${r.fraud.minTrust.toFixed(2)},${r.fraud.isFlagged},${r.fraud.riskScore}\n`;
    }
    csvFiles.a = csvA;
  }

  if (allResults.b) {
    let csvB = 'run,seed,mode,deliveryRate,delivered,dropped,tampered,overhead,deliveryTimeMs\n';
    for (const r of allResults.b) {
      csvB += `${r.run},${r.seed},flood,${r.flood.deliveryRate.toFixed(2)},${r.flood.delivered},${r.flood.dropped},${r.flood.tampered},${r.flood.overhead.toFixed(2)},${r.flood.deliveryTimeMs ?? 0}\n`;
      csvB += `${r.run},${r.seed},trust-aware,${r.trustAware.deliveryRate.toFixed(2)},${r.trustAware.delivered},${r.trustAware.dropped},${r.trustAware.tampered},${r.trustAware.overhead.toFixed(2)},${r.trustAware.deliveryTimeMs ?? 0}\n`;
    }
    csvFiles.b = csvB;
  }

  if (allResults.c) {
    let csvC = 'dropRate,run,seed,deliveryRate,delivered,dropped,overhead\n';
    for (const group of allResults.c) {
      for (const r of group.runs) {
        csvC += `${group.dropRate},${r.run},${r.seed},${r.deliveryRate.toFixed(2)},${r.delivered},${r.dropped},${r.overhead.toFixed(2)}\n`;
      }
    }
    csvFiles.c = csvC;
  }

  if (allResults.d) {
    let csvD = 'nodeCount,run,seed,deliveryRate,hops,overhead,deliveryTimeMs\n';
    for (const group of allResults.d) {
      for (const r of group.runs) {
        csvD += `${group.nodeCount},${r.run},${r.seed},${r.deliveryRate.toFixed(2)},${r.hops},${r.overhead.toFixed(2)},${r.deliveryTimeMs ?? 0}\n`;
      }
    }
    csvFiles.d = csvD;
  }

  if (allResults.e) {
    let csvE = 'type,run,seed,tamperedCount,isFlagged,firstDeliveries,replayDeliveries,bothReached\n';
    for (const r of allResults.e.tamper) {
      csvE += `tamper,${r.run},${r.seed},${r.tamperedCount},${r.fraud.isFlagged},,,\n`;
    }
    for (const r of allResults.e.replay) {
      csvE += `replay,${r.run},${r.seed},,,${r.firstDeliveries},${r.replayDeliveries},\n`;
    }
    for (const r of allResults.e.duplicate) {
      csvE += `duplicate,${r.run},${r.seed},,,,${r.deliveriesFromSrc1},${r.bothReached}\n`;
    }
    csvFiles.e = csvE;
  }

  if (allResults.f) {
    let csvF = 'run,seed,maliciousId,maliciousScore,minHonestScore,separated,edges\n';
    for (const r of allResults.f) {
      csvF += `${r.run},${r.seed},${r.maliciousId},${r.maliciousScore},${r.minHonestScore},${r.separated},${r.topologyEdges.length}\n`;
    }
    csvFiles.f = csvF;
  }

  // Target directories to mirror (simulator results, mern/results, and root results)
  const targetDirs = [
    RESULTS_DIR,
    path.resolve(__dirname, '..', '..', 'results'),
    path.resolve(__dirname, '..', '..', '..', 'results'),
  ];

  for (const dir of targetDirs) {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
  }

  for (const [id, data] of Object.entries(allResults)) {
    for (const dir of targetDirs) {
      if (fs.existsSync(dir)) {
        fs.writeFileSync(path.join(dir, `exp_${id}.json`), JSON.stringify(data, null, 2), 'utf8');
        if (csvFiles[id]) {
          fs.writeFileSync(path.join(dir, `exp_${id}.csv`), csvFiles[id], 'utf8');
        }
      }
    }
    console.log(`\nWritten: exp_${id}.json & exp_${id}.csv`);
  }

  // Write combined summary
  const summaryPayload = JSON.stringify({
    generated: new Date().toISOString(),
    experiments: Object.keys(allResults),
    note: 'Seeds: a–e: runIndex*1000+expIndex (a=0…e=4); f: runIndex*1000+5',
  }, null, 2);

  // --only must not wipe the combined summary of experiments that were not rerun.
  if (!only) {
    for (const dir of targetDirs) {
      if (fs.existsSync(dir)) {
        fs.writeFileSync(path.join(dir, 'summary.json'), summaryPayload, 'utf8');
      }
    }
  }

  console.log(`\n✅  Experiments complete. Results in: ${RESULTS_DIR}`);
}

main().catch((err) => {
  console.error('Experiment harness error:', err);
  process.exit(1);
});
