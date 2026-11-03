export class VirtualDevice {
  constructor(deviceId, hasInternet = false) {
    this.deviceId = deviceId;
    this.hasInternet = hasInternet;
    this.heldPackets = new Map(); // packetId -> MeshPacket
  }

  hold(packet) {
    if (!this.heldPackets.has(packet.packetId)) {
      this.heldPackets.set(packet.packetId, { ...packet });
    }
  }

  holds(packetId) {
    return this.heldPackets.has(packetId);
  }

  getHeldPackets() {
    return Array.from(this.heldPackets.values());
  }

  packetCount() {
    return this.heldPackets.size;
  }

  clear() {
    this.heldPackets.clear();
  }
}

export class MeshSimulatorService {
  constructor() {
    this.devices = new Map();
    this.listeners = new Set();
    this.seedDefaultDevices();
  }

  seedDefaultDevices() {
    this.devices.clear();
    this.devices.set('phone-alice', new VirtualDevice('phone-alice', false));
    this.devices.set('phone-stranger1', new VirtualDevice('phone-stranger1', false));
    this.devices.set('phone-stranger2', new VirtualDevice('phone-stranger2', false));
    this.devices.set('phone-stranger3', new VirtualDevice('phone-stranger3', false));
    this.devices.set('phone-bridge', new VirtualDevice('phone-bridge', true));
  }

  getDevices() {
    return Array.from(this.devices.values());
  }

  getDevice(id) {
    return this.devices.get(id);
  }

  inject(senderDeviceId, packet) {
    const device = this.devices.get(senderDeviceId);
    if (!device) {
      throw new Error(`Unknown device: ${senderDeviceId}`);
    }
    device.hold(packet);
    this.notify({
      type: 'PACKET_INJECTED',
      deviceId: senderDeviceId,
      packetId: packet.packetId,
      ttl: packet.ttl,
    });
  }

  gossipOnce() {
    let transfers = 0;
    const deviceList = Array.from(this.devices.values());

    // Snapshot state before this round
    const snapshot = new Map();
    for (const d of deviceList) {
      snapshot.set(d.deviceId, d.getHeldPackets());
    }

    const hops = [];
    for (const src of deviceList) {
      const packets = snapshot.get(src.deviceId) || [];
      for (const pkt of packets) {
        if (pkt.ttl <= 0) continue;
        for (const dst of deviceList) {
          if (dst === src) continue;
          if (dst.holds(pkt.packetId)) continue;

          const copy = {
            packetId: pkt.packetId,
            ttl: pkt.ttl - 1,
            createdAt: pkt.createdAt,
            ciphertext: pkt.ciphertext,
          };
          dst.hold(copy);
          transfers++;
          hops.push({ from: src.deviceId, to: dst.deviceId, packetId: pkt.packetId });
        }
      }
    }

    const deviceCounts = this.snapshotMap();
    this.notify({
      type: 'GOSSIP_COMPLETED',
      transfers,
      deviceCounts,
      hops,
    });

    return { transfers, deviceCounts };
  }

  snapshotMap() {
    const map = {};
    for (const [id, dev] of this.devices.entries()) {
      map[id] = dev.packetCount();
    }
    return map;
  }

  collectBridgeUploads() {
    const uploads = [];
    for (const dev of this.devices.values()) {
      if (!dev.hasInternet) continue;
      for (const pkt of dev.getHeldPackets()) {
        uploads.push({
          bridgeNodeId: dev.deviceId,
          packet: pkt,
        });
      }
    }
    return uploads;
  }

  resetMesh() {
    for (const dev of this.devices.values()) {
      dev.clear();
    }
    this.notify({ type: 'MESH_RESET' });
  }

  onEvent(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify(event) {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {}
    }
  }
}

export const meshSimulatorService = new MeshSimulatorService();
