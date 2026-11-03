import { MeshNode } from './meshNode.js';

export class MeshNetwork {
  constructor({ dropRate = 0.0, hopDelayMs = 300, maxHops = 5 } = {}) {
    this.dropRate = dropRate;
    this.hopDelayMs = hopDelayMs;
    this.maxHops = maxHops;
    this.nodes = new Map();
    this.listeners = new Set();
    this.buildDefaultTopology();
  }

  buildDefaultTopology() {
    this.nodes.clear();

    const nodeConfigs = [
      { id: 'phone-alice', label: 'Alice (Sender)', hasInternet: false, x: 80, y: 150 },
      { id: 'phone-stranger1', label: 'Stranger 1 (Corridor)', hasInternet: false, x: 220, y: 100 },
      { id: 'phone-stranger2', label: 'Stranger 2 (Stairs)', hasInternet: false, x: 220, y: 220 },
      { id: 'phone-rogue', label: 'Rogue Node (Tamperer)', hasInternet: false, isRogue: true, x: 360, y: 80 },
      { id: 'phone-stranger3', label: 'Stranger 3 (Lobby)', hasInternet: false, x: 360, y: 200 },
      { id: 'phone-bridge1', label: 'Bridge 1 (Main Gate 4G)', hasInternet: true, x: 500, y: 120 },
      { id: 'phone-bridge2', label: 'Bridge 2 (Parking 4G)', hasInternet: true, x: 500, y: 240 },
      { id: 'phone-bob', label: 'Bob (Recipient)', hasInternet: false, x: 220, y: 320 },
    ];

    for (const cfg of nodeConfigs) {
      this.nodes.set(cfg.id, new MeshNode(cfg));
    }

    // Connect topology
    this.connect('phone-alice', 'phone-stranger1');
    this.connect('phone-alice', 'phone-stranger2');
    this.connect('phone-stranger1', 'phone-rogue');
    this.connect('phone-stranger1', 'phone-stranger3');
    this.connect('phone-stranger2', 'phone-stranger3');
    this.connect('phone-stranger2', 'phone-bob');
    this.connect('phone-rogue', 'phone-bridge1');
    this.connect('phone-stranger3', 'phone-bridge1');
    this.connect('phone-stranger3', 'phone-bridge2');
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
      id: n.id,
      label: n.label,
      hasInternet: n.hasInternet,
      isRogue: n.isRogue,
      x: n.x,
      y: n.y,
      packetCount: n.packetCache.size,
    }));

    const edges = [];
    const seen = new Set();
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

  /**
   * Injects a packet at a source node and initiates gossip hopping.
   *
   * @param {string} sourceId
   * @param {object} packet
   * @param {object} options
   * @returns {Promise<Array<{ bridgeId: string, packet: object, hops: number, path: string[] }>>}
   */
  async propagatePacket(sourceId, packet, { shouldTamper = false } = {}) {
    const source = this.nodes.get(sourceId);
    if (!source) throw new Error(`Unknown source node: ${sourceId}`);

    source.storePacket(packet);
    this.emit({
      type: 'PACKET_INJECTED',
      nodeId: sourceId,
      packetId: packet.packetId,
      ttl: packet.ttl,
    });

    const bridgeDeliveries = [];
    // Queue of { currentId, currentPacket, currentHopCount, path }
    const queue = [{
      currentId: sourceId,
      currentPacket: { ...packet },
      hopCount: 0,
      path: [sourceId],
    }];

    while (queue.length > 0) {
      const { currentId, currentPacket, hopCount, path } = queue.shift();
      const currentNode = this.nodes.get(currentId);

      // Delay between hops to simulate real-world transmission
      if (this.hopDelayMs > 0 && hopCount > 0) {
        await new Promise((r) => setTimeout(r, this.hopDelayMs));
      }

      if (currentNode.hasInternet) {
        bridgeDeliveries.push({
          bridgeId: currentId,
          packet: { ...currentPacket },
          hopCount,
          path,
        });
        this.emit({
          type: 'BRIDGE_REACHED',
          bridgeId: currentId,
          packetId: currentPacket.packetId,
          hopCount,
          path,
        });
        // Continue hopping if TTL allows, to allow multi-bridge duplicates
      }

      if (currentPacket.ttl <= 0) continue;

      for (const peerId of currentNode.peers) {
        if (path.includes(peerId)) continue; // Avoid immediate backtrack

        const peer = this.nodes.get(peerId);
        if (!peer) continue;

        // Simulate packet drop
        if (this.dropRate > 0 && Math.random() < this.dropRate) {
          this.emit({
            type: 'PACKET_DROPPED',
            from: currentId,
            to: peerId,
            packetId: currentPacket.packetId,
          });
          continue;
        }

        let relayedPacket = {
          ...currentPacket,
          ttl: currentPacket.ttl - 1,
        };

        // If the node is rogue or tampering scenario requested
        if ((currentNode.isRogue || shouldTamper) && currentId === 'phone-rogue') {
          const buf = Buffer.from(relayedPacket.ciphertext, 'base64');
          buf[Math.floor(buf.length / 2)] ^= 0xff; // Flip a byte in the encrypted payload
          relayedPacket.ciphertext = buf.toString('base64');

          this.emit({
            type: 'PACKET_TAMPERED',
            rogueNode: currentId,
            packetId: relayedPacket.packetId,
          });
        }

        peer.storePacket(relayedPacket);

        this.emit({
          type: 'PACKET_HOP',
          from: currentId,
          to: peerId,
          packetId: relayedPacket.packetId,
          ttl: relayedPacket.ttl,
          hopCount: hopCount + 1,
        });

        queue.push({
          currentId: peerId,
          currentPacket: relayedPacket,
          hopCount: hopCount + 1,
          path: [...path, peerId],
        });
      }
    }

    return bridgeDeliveries;
  }

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
      try {
        cb(event);
      } catch {}
    }
  }
}
