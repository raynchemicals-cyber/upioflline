/**
 * meshNetwork.js — BFS-flooding mesh with optional trust-aware routing
 *
 * ROUTING MODES
 * ─────────────
 * 'flood' (default):
 *   Forward to every reachable peer — original behaviour, unchanged.
 *   Comparable baseline for experiments.
 *
 * 'trust-aware':
 *   Sort peers by trust score (descending), select top-k eligible peers.
 *   ANTI-PARTITION FALLBACKS (two layers):
 *     1. ε-Greedy exploration (default ε = 0.10): with probability ε, one
 *        random peer from the full candidate set is added to the forwarding
 *        list regardless of its score. This lets new/recovering relays
 *        receive traffic and prevents them from being permanently excluded.
 *     2. Full fallback to flooding: if NO peer meets minTrustThreshold after
 *        excluding explored peers, all candidates are forwarded to, preventing
 *        network partitions in hostile environments.
 *
 * RANDOMNESS
 * ──────────
 * All probabilistic decisions (drop, tamper, exploration) route through the
 * caller-supplied seeded RNG (createSeededRng) so runs are reproducible.
 * No Math.random() calls in this file.
 *
 * TIME
 * ────
 * When useRealTime=false (experiment mode) delays advance the SimulatedClock
 * rather than calling setTimeout. When useRealTime=true (dashboard/live) real
 * setTimeout is used for smooth UI animation.
 *
 * TRUST UPDATES (applied after each propagatePacket call)
 * ───────────────────────────────────────────────────────
 * Successful path relay  : forward_ok  (+3) per hop node
 * Bridge delivery        : delivered   (+5) on bridge node
 * Packet dropped         : drop        (−8) on the forwarding node
 * Direct tamperer        : tamper     (−35) on the tampering node
 * Other node on tampered path: path_contaminated (−5)
 *
 * BLAME ATTRIBUTION
 * ─────────────────
 * The simulator knows exactly which node tampered (shouldTamper() returned
 * true). That node gets DELTA_TAMPER. Every other relay on that specific path
 * (including the destination bridge) gets DELTA_PATH_CONTAMINATED.
 */

import { MeshNode }     from './meshNode.js';
import { TrustManager } from './trustManager.js';
import { SimulatedClock }   from './simulatedClock.js';
import { createSeededRng }  from './seededRandom.js';

const DEFAULT_EXPLORATION_PROB  = 0.10;
const DEFAULT_MIN_TRUST         = 30;
const DEFAULT_MAX_NEXT_HOPS     = 3;

export class MeshNetwork {
  /**
   * @param {object} [opts]
   * @param {number}       [opts.dropRate=0]           Network-level uniform drop probability
   * @param {number}       [opts.hopDelayMs=300]        Simulated ms per hop
   * @param {number}       [opts.maxHops=5]
   * @param {'flood'|'trust-aware'} [opts.routingMode='flood']
   * @param {number}       [opts.explorationProb=0.10]  ε for ε-greedy exploration
   * @param {number}       [opts.minTrustThreshold=30]  Hard cutoff in trust-aware mode
   * @param {number}       [opts.maxNextHops=3]          Max peers selected per hop
   * @param {TrustManager} [opts.trustManager]           Shared trust tracker (injected)
   * @param {SimulatedClock} [opts.clock]                Shared simulated clock (injected)
   * @param {() => number} [opts.rng]                    Seeded PRNG (injected)
   * @param {boolean}      [opts.useRealTime=false]       true = real setTimeout (dashboard mode)
   * @param {(packet: object) => boolean} [opts.verifySignature]
   *   When set, each relay checks the sender signature over the ciphertext
   *   without decrypting. A failure drops the packet and applies `tamper`
   *   to the previous hop only. Ground-truth path blame is then skipped.
   */
  constructor({
    dropRate          = 0.0,
    hopDelayMs        = 300,
    maxHops           = 5,
    routingMode       = 'flood',
    explorationProb   = DEFAULT_EXPLORATION_PROB,
    minTrustThreshold = DEFAULT_MIN_TRUST,
    maxNextHops       = DEFAULT_MAX_NEXT_HOPS,
    trustManager,
    clock,
    rng,
    useRealTime       = false,
    verifySignature   = null,
  } = {}) {
    this.dropRate          = dropRate;
    this.hopDelayMs        = hopDelayMs;
    this.maxHops           = maxHops;
    this.routingMode       = routingMode;
    this.explorationProb   = explorationProb;
    this.minTrustThreshold = minTrustThreshold;
    this.maxNextHops       = maxNextHops;
    this.useRealTime       = useRealTime;
    this.verifySignature   = verifySignature;

    // Shared objects — created here if not injected (dashboard mode)
    this.trustManager = trustManager || new TrustManager();
    this.clock        = clock        || new SimulatedClock();
    this.rng          = rng          || createSeededRng(1);

    this.nodes     = new Map();
    this.listeners = new Set();
    this.buildDefaultTopology();
  }

  // ─── Topology ─────────────────────────────────────────────────────────────

  buildDefaultTopology() {
    this.nodes.clear();

    const nodeConfigs = [
      { id: 'phone-alice',     label: 'Alice (Sender)',           hasInternet: false, x:  80, y: 150 },
      { id: 'phone-stranger1', label: 'Stranger 1 (Corridor)',    hasInternet: false, x: 220, y: 100 },
      { id: 'phone-stranger2', label: 'Stranger 2 (Stairs)',      hasInternet: false, x: 220, y: 220 },
      { id: 'phone-rogue',     label: 'Rogue Node (Tamperer)',    hasInternet: false, isRogue: true, behaviourProfile: 'malicious', x: 360, y:  80 },
      { id: 'phone-stranger3', label: 'Stranger 3 (Lobby)',       hasInternet: false, x: 360, y: 200 },
      { id: 'phone-bridge1',   label: 'Bridge 1 (Main Gate 4G)', hasInternet: true,  x: 500, y: 120 },
      { id: 'phone-bridge2',   label: 'Bridge 2 (Parking 4G)',   hasInternet: true,  x: 500, y: 240 },
      { id: 'phone-bob',       label: 'Bob (Recipient)',          hasInternet: false, x: 220, y: 320 },
    ];

    for (const cfg of nodeConfigs) {
      this.nodes.set(cfg.id, new MeshNode(cfg));
    }

    this.connect('phone-alice',    'phone-stranger1');
    this.connect('phone-alice',    'phone-stranger2');
    this.connect('phone-stranger1','phone-rogue');
    this.connect('phone-stranger1','phone-stranger3');
    this.connect('phone-stranger2','phone-stranger3');
    this.connect('phone-stranger2','phone-bob');
    this.connect('phone-rogue',    'phone-bridge1');
    this.connect('phone-stranger3','phone-bridge1');
    this.connect('phone-stranger3','phone-bridge2');
  }

  connect(idA, idB) {
    const a = this.nodes.get(idA);
    const b = this.nodes.get(idB);
    if (a && b) {
      a.addPeer(idB);
      b.addPeer(idA);
    }
  }

  getTopology() {
    const nodes = Array.from(this.nodes.values()).map((n) => ({
      id:               n.id,
      label:            n.label,
      hasInternet:      n.hasInternet,
      isRogue:          n.isRogue,
      behaviourProfile: n.behaviourProfile,
      trustScore:       parseFloat(this.trustManager.getScore(n.id).toFixed(2)),
      classification:   this.trustManager.classify(n.id),
      x:                n.x,
      y:                n.y,
      packetCount:      n.packetCache.size,
    }));

    const edges = [];
    const seen  = new Set();
    for (const node of this.nodes.values()) {
      for (const peerId of node.peers) {
        const key = [node.id, peerId].sort().join('--');
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ source: node.id, target: peerId });
        }
      }
    }

    return { nodes, edges };
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  /**
   * Choose which peers to forward to from currentNode.
   * Excludes already-visited nodes to prevent loops.
   *
   * In 'flood' mode: returns all candidates (unchanged behaviour).
   * In 'trust-aware' mode:
   *   1. Rank candidates by trust score (descending)
   *   2. Keep top-k above minTrustThreshold
   *   3. ε-greedy: with prob explorationProb, add one random extra peer
   *   4. Fallback: if no peer is eligible, flood all (prevent partition)
   *
   * @param {MeshNode} currentNode
   * @param {string[]} path  Already-visited node IDs
   * @returns {string[]}     Peer IDs to forward to
   */
  _choosePeers(currentNode, path) {
    const candidateIds = Array.from(currentNode.peers).filter(
      (id) => !path.includes(id) && this.nodes.has(id)
    );

    if (this.routingMode === 'flood' || candidateIds.length === 0) {
      return candidateIds;
    }

    // ── Trust-aware routing ──────────────────────────────────────────────────
    const ranked = candidateIds
      .map((id) => ({ id, trust: this.trustManager.getScore(id) }))
      .sort((a, b) => b.trust - a.trust);

    const eligible = ranked
      .filter((p) => p.trust >= this.minTrustThreshold)
      .slice(0, this.maxNextHops)
      .map((p) => p.id);

    // ── Partition-safe fallback: no eligible peers → flood all ───────────────
    if (eligible.length === 0) {
      this.emit({
        type:   'ROUTING_FALLBACK',
        nodeId: currentNode.id,
        reason: 'no_eligible_peers',
        peers:  candidateIds,
      });
      return candidateIds;
    }

    // ── ε-Greedy exploration ─────────────────────────────────────────────────
    if (this.rng() < this.explorationProb) {
      const pool = candidateIds.filter((id) => !eligible.includes(id));
      if (pool.length > 0) {
        const exploredId = pool[Math.floor(this.rng() * pool.length)];
        this.emit({
          type:         'ROUTING_EXPLORE',
          nodeId:       currentNode.id,
          exploredPeer: exploredId,
        });
        return [...eligible, exploredId];
      }
    }

    return eligible;
  }

  // ─── Packet Propagation ───────────────────────────────────────────────────

  /**
   * Inject a packet at sourceId and propagate it through the mesh via BFS.
   *
   * @param {string} sourceId
   * @param {object} packet   { packetId, ttl, createdAt, ciphertext }
   * @param {object} [options]
   * @param {boolean} [options.shouldTamper=false]  Legacy override (backward compat)
   * @returns {Promise<Array<{bridgeId,packet,hopCount,path,deliveryTimeMs}>>}
   */
  async propagatePacket(sourceId, packet, { shouldTamper: legacyTamper = false } = {}) {
    const source = this.nodes.get(sourceId);
    if (!source) throw new Error(`Unknown source node: ${sourceId}`);

    const startTime = this.clock.now;
    source.storePacket(packet, this.clock.now);

    this.emit({
      type:     'PACKET_INJECTED',
      nodeId:   sourceId,
      packetId: packet.packetId,
      ttl:      packet.ttl,
    });

    const bridgeDeliveries = [];   // successful deliveries
    const droppedHops      = [];   // { from, packetId } — forwarding node dropped
    const tamperedNodes    = [];   // { tampererNodeId, path }

    const queue = [{
      currentId:     sourceId,
      currentPacket: { ...packet },
      hopCount:      0,
      path:          [sourceId],
    }];

    while (queue.length > 0) {
      const { currentId, currentPacket, hopCount, path } = queue.shift();
      const currentNode = this.nodes.get(currentId);
      if (!currentNode) continue;

      // ── Signed-hop verification (no decryption) ────────────────────────────
      // The sender signed the ciphertext hash. A relay that sees a mismatch
      // drops the packet and penalises only the previous hop.
      if (this.verifySignature && path.length > 1) {
        let valid = false;
        try { valid = this.verifySignature(currentPacket) === true; } catch { valid = false; }
        if (!valid) {
          const previousHop = path[path.length - 2];
          this.trustManager.update(previousHop, 'tamper');
          this.emit({
            type:        'SIG_REJECTED',
            nodeId:      currentId,
            previousHop,
            packetId:    currentPacket.packetId,
          });
          continue;
        }
      }

      // ── Simulated hop delay ─────────────────────────────────────────────────
      if (this.hopDelayMs > 0 && hopCount > 0) {
        const delay = this.hopDelayMs * currentNode.delayMultiplier;
        if (this.useRealTime) {
          await new Promise((r) => setTimeout(r, delay));
        } else {
          this.clock.advance(delay);
        }
      }

      // ── Bridge reached ──────────────────────────────────────────────────────
      if (currentNode.hasInternet) {
        const deliveryTimeMs = this.clock.now - startTime;
        bridgeDeliveries.push({
          bridgeId:       currentId,
          packet:         { ...currentPacket },
          hopCount,
          path,
          deliveryTimeMs,
        });
        this.emit({
          type:            'BRIDGE_REACHED',
          bridgeId:        currentId,
          packetId:        currentPacket.packetId,
          hopCount,
          path,
          deliveryTimeMs,
        });
        // Continue: allow multi-bridge delivery for idempotency demo
      }

      if (currentPacket.ttl <= 0) continue;

      const peerIds = this._choosePeers(currentNode, path);

      for (const peerId of peerIds) {
        const peer = this.nodes.get(peerId);
        if (!peer) continue;

        // ── Node-level drop (behaviour profile) ─────────────────────────────
        // The currentNode is the one FORWARDING; it decides to drop.
        if (currentNode.shouldDrop(this.rng)) {
          droppedHops.push({ from: currentId, packetId: currentPacket.packetId });
          this.emit({
            type:     'PACKET_DROPPED',
            from:     currentId,
            to:       peerId,
            packetId: currentPacket.packetId,
          });
          continue;
        }

        // ── Network-level drop (uniform dropRate, all nodes) ─────────────────
        if (this.dropRate > 0 && this.rng() < this.dropRate) {
          droppedHops.push({ from: currentId, packetId: currentPacket.packetId });
          this.emit({
            type:     'PACKET_DROPPED',
            from:     currentId,
            to:       peerId,
            packetId: currentPacket.packetId,
          });
          continue;
        }

        let relayedPacket = { ...currentPacket, ttl: currentPacket.ttl - 1 };

        // ── Tampering (malicious profile or legacy shouldTamper flag) ─────────
        const tampers =
          currentNode.shouldTamper(this.rng) ||
          (legacyTamper && currentId === 'phone-rogue');

        if (tampers) {
          const buf = Buffer.from(relayedPacket.ciphertext, 'base64');
          buf[Math.floor(buf.length / 2)] ^= 0xff;
          relayedPacket.ciphertext = buf.toString('base64');

          tamperedNodes.push({ tampererNodeId: currentId, path: [...path, peerId] });

          this.emit({
            type:      'PACKET_TAMPERED',
            rogueNode: currentId,
            packetId:  relayedPacket.packetId,
          });
        }

        peer.storePacket(relayedPacket, this.clock.now);

        this.emit({
          type:     'PACKET_HOP',
          from:     currentId,
          to:       peerId,
          packetId: relayedPacket.packetId,
          ttl:      relayedPacket.ttl,
          hopCount: hopCount + 1,
        });

        queue.push({
          currentId:     peerId,
          currentPacket: relayedPacket,
          hopCount:      hopCount + 1,
          path:          [...path, peerId],
        });
      }
    }

    // ─── Apply trust updates after BFS completes ─────────────────────────────
    this._applyTrustUpdates(sourceId, bridgeDeliveries, droppedHops, tamperedNodes, packet.ciphertext);

    return bridgeDeliveries;
  }

  /**
   * Apply post-propagation trust updates.
   * Called once per propagatePacket() run; deterministic given the same events.
   *
   * @private
   */
  _applyTrustUpdates(sourceId, bridgeDeliveries, droppedHops, tamperedNodesIn, originalCiphertext) {
    // 1. Reward relays on verified delivery paths
    for (const delivery of bridgeDeliveries) {
      const isVerified = originalCiphertext ? delivery.packet.ciphertext === originalCiphertext : true;
      if (isVerified) {
        for (const nodeId of delivery.path) {
          if (nodeId === sourceId) continue;
          this.trustManager.update(nodeId, 'forward_ok');
        }
        this.trustManager.update(delivery.bridgeId, 'delivered');
      }
    }

    // 2. Penalize nodes that dropped packets (delivery-receipt / timeout)
    // The 'from' field is the forwarding node that failed to pass the packet on.
    const penalizedForDrops = new Set();
    for (const { from } of droppedHops) {
      if (!penalizedForDrops.has(from)) {
        this.trustManager.update(from, 'drop');
        penalizedForDrops.add(from); // one penalty per node per propagation run
      }
    }

    // 3. Blame attribution for tampered packets.
    // Signed-hop mode already penalised the previous hop at verification time
    // and must not also apply ground-truth tamper / path_contaminated.
    // NOTE: uses simulator ground truth (behaviourProfile === 'malicious') to
    // identify the tamperer; this is documented in README "What's not real".
    const tamperedNodes = this.verifySignature ? [] : tamperedNodesIn;
    for (const { tampererNodeId, path } of tamperedNodes) {
      // Direct tamperer: full penalty
      this.trustManager.update(tampererNodeId, 'tamper');
      // Other nodes on the contaminated path: share the blame
      for (const nodeId of path) {
        if (nodeId === tampererNodeId || nodeId === sourceId) continue;
        this.trustManager.update(nodeId, 'path_contaminated');
      }
    }

    // Sync trustScore into MeshNode for _choosePeers lookup (avoids Map lookups per hop)
    for (const [id, node] of this.nodes.entries()) {
      node.trustScore = this.trustManager.getScore(id);
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  reset() {
    for (const node of this.nodes.values()) {
      node.clear();
    }
    this.emit({ type: 'MESH_RESET' });
  }

  onEvent(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(event) {
    for (const cb of this.listeners) {
      try { cb(event); } catch {}
    }
  }
}
