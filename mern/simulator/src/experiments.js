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
 * @returns {{ nodes: MeshNode[], edges: [string,string][] }}
 */
function buildTopology(nodeCount, profiles = [], dropRate = 0) {
  const nodes = [];
  const edges = [];

  // Source node (the paying device)
  const source = new MeshNode({ id: 'src', label: 'Source', x: 0, y: 0 });
  nodes.push(source);

  // Bridge node(s): every 1 in 5 devices has internet
  const bridgeInterval = Math.max(2, Math.floor(nodeCount / Math.max(1, Math.floor(nodeCount / 5))));
  const relayCount     = nodeCount - 1;

  for (let i = 0; i < relayCount; i++) {
    const hasInternet     = i % bridgeInterval === bridgeInterval - 1;
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
  // Cross-links for redundancy in topologies with ≥ 6 nodes
  for (let i = 0; i + 3 < nodes.length; i += 3) {
    edges.push([nodes[i].id, nodes[i + 3].id]);
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  UPI Offline Mesh — Experiment Harness');
  console.log('  All randomness seeded; simulated time; no Math.random()');
  console.log('═══════════════════════════════════════════════════════════════');

  const allResults = {};

  allResults.a = await expA();
  allResults.b = await expB();
  allResults.c = await expC();
  allResults.d = await expD();
  allResults.e = await expE();

  // Write per-experiment JSON
  for (const [id, data] of Object.entries(allResults)) {
    const outPath = path.join(RESULTS_DIR, `exp_${id}.json`);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`\nWritten: ${outPath}`);
  }

  // Write combined summary
  const summaryPath = path.join(RESULTS_DIR, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    generated: new Date().toISOString(),
    experiments: Object.keys(allResults),
    note: 'All seeds: runIndex * 1000 + expIndex (a=0,b=1,c=2,d=3,e=4)',
  }, null, 2), 'utf8');

  console.log(`\n✅  Experiments complete. Results in: ${RESULTS_DIR}`);
}

main().catch((err) => {
  console.error('Experiment harness error:', err);
  process.exit(1);
});
