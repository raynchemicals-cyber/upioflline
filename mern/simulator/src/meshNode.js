export class MeshNode {
  constructor({ id, label, hasInternet = false, isRogue = false, x = 0, y = 0 }) {
    this.id = id;
    this.label = label || id;
    this.hasInternet = hasInternet;
    this.isRogue = isRogue;
    this.x = x;
    this.y = y;
    this.peers = new Set();
    this.packetCache = new Map(); // packetId -> { packet, receivedAt }
  }

  addPeer(peerId) {
    this.peers.add(peerId);
  }

  removePeer(peerId) {
    this.peers.delete(peerId);
  }

  hasPacket(packetId) {
    return this.packetCache.has(packetId);
  }

  storePacket(packet) {
    this.packetCache.set(packet.packetId, {
      packet: { ...packet },
      receivedAt: Date.now(),
    });
  }

  getPackets() {
    return Array.from(this.packetCache.values()).map((v) => v.packet);
  }

  clear() {
    this.packetCache.clear();
  }
}
