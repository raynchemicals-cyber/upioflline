import crypto from 'node:crypto';

export function createClientPacket({
  serverPublicKeyBase64,
  senderVpa,
  receiverVpa,
  amount,
  pin = '1234',
  ttl = 5,
  timestamp = Date.now(),
}) {
  const instruction = {
    senderVpa,
    receiverVpa,
    amount: Number(amount),
    pinHash: crypto.createHash('sha256').update(pin, 'utf8').digest('hex'),
    nonce: crypto.randomUUID(),
    signedAt: timestamp,
  };

  const plaintext = Buffer.from(JSON.stringify(instruction), 'utf8');
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const aesCiphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const pubKey = crypto.createPublicKey({
    key: Buffer.from(serverPublicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });

  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: pubKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );

  const packed = Buffer.concat([encryptedAesKey, iv, aesCiphertext, authTag]);

  return {
    packetId: crypto.randomUUID(),
    ttl,
    createdAt: timestamp,
    ciphertext: packed.toString('base64'),
  };
}

export class ScenarioRunner {
  constructor({ network, serverUrl = 'http://localhost:8080' }) {
    this.network = network;
    this.serverUrl = serverUrl;
    this.serverKeyBase64 = null;
  }

  async getServerKey() {
    if (!this.serverKeyBase64) {
      const res = await fetch(`${this.serverUrl}/api/server-key`).then((r) => r.json());
      this.serverKeyBase64 = res.publicKey;
    }
    return this.serverKeyBase64;
  }

  async runScenario(name) {
    switch (name) {
      case 'normal':
      case 'normal_payment':
        return this.runNormalPayment();
      case 'duplicate':
      case 'duplicate_delivery':
        return this.runDuplicateDelivery();
      case 'tampered':
      case 'tampered_packet':
        return this.runTamperedPacket();
      case 'replay':
      case 'replayed_packet':
        return this.runReplayedPacket();
      case 'velocity':
      case 'velocity_burst':
        return this.runVelocityBurst();
      default:
        throw new Error(`Unknown scenario: ${name}`);
    }
  }

  /**
   * Scenario 1: Normal payment
   * Offline sender phone encrypts payment with cached RSA key.
   * Packet hops hop-by-hop across mesh until it reaches bridge node and settles.
   */
  async runNormalPayment() {
    this.network.reset();
    const serverKey = await this.getServerKey();

    this.network.emit({
      type: 'SCENARIO_START',
      scenario: 'normal',
      title: 'Normal Payment',
      description: 'Alice creates ₹150 offline payment to Bob. Packet hops through mesh to bridge.',
    });

    const packet = createClientPacket({
      serverPublicKeyBase64: serverKey,
      senderVpa: 'alice@demo',
      receiverVpa: 'bob@demo',
      amount: 150.0,
      ttl: 5,
    });

    const deliveries = await this.network.propagatePacket('phone-alice', packet);

    if (deliveries.length > 0) {
      const delivery = deliveries[0];
      const ingestRes = await this.uploadToBridge(delivery);

      this.network.emit({
        type: 'SCENARIO_COMPLETE',
        scenario: 'normal',
        outcome: ingestRes.outcome,
        details: ingestRes,
      });
      return ingestRes;
    }
  }

  /**
   * Scenario 2: Duplicate delivery through multiple bridges
   * Demonstrates idempotency under concurrency when 2 bridges upload at once.
   */
  async runDuplicateDelivery() {
    this.network.reset();
    const serverKey = await this.getServerKey();

    this.network.emit({
      type: 'SCENARIO_START',
      scenario: 'duplicate',
      title: 'Duplicate Delivery (Idempotency)',
      description: 'Single payment hops to 2 distinct bridge nodes, both uploading simultaneously.',
    });

    const packet = createClientPacket({
      serverPublicKeyBase64: serverKey,
      senderVpa: 'alice@demo',
      receiverVpa: 'carol@demo',
      amount: 200.0,
      ttl: 5,
    });

    await this.network.propagatePacket('phone-alice', packet);

    // Upload concurrently from both bridge nodes
    const bridgeUploads = [
      { bridgeId: 'phone-bridge1', hopCount: 3, path: ['phone-alice', 'phone-stranger1', 'phone-stranger3', 'phone-bridge1'], packet },
      { bridgeId: 'phone-bridge2', hopCount: 3, path: ['phone-alice', 'phone-stranger2', 'phone-stranger3', 'phone-bridge2'], packet },
    ];

    const results = await Promise.all(
      bridgeUploads.map((delivery) => this.uploadToBridge(delivery))
    );

    this.network.emit({
      type: 'SCENARIO_COMPLETE',
      scenario: 'duplicate',
      results,
    });
    return results;
  }

  /**
   * Scenario 3: Tampered packet
   * Rogue relay node corrupts a byte in transit. GCM auth fails on decrypt.
   */
  async runTamperedPacket() {
    this.network.reset();
    const serverKey = await this.getServerKey();

    this.network.emit({
      type: 'SCENARIO_START',
      scenario: 'tampered',
      title: 'Tampered Packet (GCM AEAD Integrity)',
      description: 'Rogue intermediary flips a bit in the encrypted blob. Tampering detected & rejected.',
    });

    const packet = createClientPacket({
      serverPublicKeyBase64: serverKey,
      senderVpa: 'alice@demo',
      receiverVpa: 'bob@demo',
      amount: 300.0,
      ttl: 5,
    });

    const deliveries = await this.network.propagatePacket('phone-alice', packet, { shouldTamper: true });

    if (deliveries.length > 0) {
      const delivery = deliveries[0];
      const ingestRes = await this.uploadToBridge(delivery);

      this.network.emit({
        type: 'SCENARIO_COMPLETE',
        scenario: 'tampered',
        outcome: ingestRes.outcome,
        reason: ingestRes.reason,
      });
      return ingestRes;
    }
  }

  /**
   * Scenario 4: Replayed packet
   * Packet older than 24h freshness window is injected.
   */
  async runReplayedPacket() {
    this.network.reset();
    const serverKey = await this.getServerKey();

    this.network.emit({
      type: 'SCENARIO_START',
      scenario: 'replay',
      title: 'Replayed Stale Packet',
      description: 'Injecting a 28-hour old historical packet. Freshness window check rejects replay.',
    });

    const staleTimestamp = Date.now() - 28 * 3600 * 1000;
    const stalePacket = createClientPacket({
      serverPublicKeyBase64: serverKey,
      senderVpa: 'alice@demo',
      receiverVpa: 'dave@demo',
      amount: 75.0,
      timestamp: staleTimestamp,
    });

    const deliveries = await this.network.propagatePacket('phone-alice', stalePacket);

    if (deliveries.length > 0) {
      const delivery = deliveries[0];
      const ingestRes = await this.uploadToBridge(delivery);

      this.network.emit({
        type: 'SCENARIO_COMPLETE',
        scenario: 'replay',
        outcome: ingestRes.outcome,
        reason: ingestRes.reason,
      });
      return ingestRes;
    }
  }

  /**
   * Scenario 5: Velocity burst
   * Alice sends 6 rapid payments in 90 seconds without sync.
   * AI Risk engine flags the burst!
   */
  async runVelocityBurst() {
    this.network.reset();
    const serverKey = await this.getServerKey();

    this.network.emit({
      type: 'SCENARIO_START',
      scenario: 'velocity',
      title: 'Velocity Burst (AI Fraud Scoring)',
      description: 'Sender emits 6 rapid offline payments in 90s without sync. AI engine flags anomalous velocity.',
    });

    const results = [];
    for (let i = 1; i <= 6; i++) {
      const packet = createClientPacket({
        serverPublicKeyBase64: serverKey,
        senderVpa: 'alice@demo',
        receiverVpa: 'bob@demo',
        amount: 250.0 * i,
        ttl: 4,
      });

      const res = await fetch(`${this.serverUrl}/api/bridge/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Node-Id': 'phone-bridge1',
          'X-Hop-Count': `${3 + i}`,
        },
        body: JSON.stringify(packet),
      }).then((r) => r.json());

      results.push(res);
      this.network.emit({
        type: 'BURST_PAYMENT_PROCESSED',
        index: i,
        outcome: res.outcome,
        riskScore: res.riskScore,
      });

      await new Promise((r) => setTimeout(r, 200));
    }

    this.network.emit({
      type: 'SCENARIO_COMPLETE',
      scenario: 'velocity',
      results,
    });
    return results;
  }

  async uploadToBridge(delivery) {
    const res = await fetch(`${this.serverUrl}/api/bridge/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Node-Id': delivery.bridgeId,
        'X-Hop-Count': String(delivery.hopCount),
        'X-Relay-Nodes': delivery.path ? delivery.path.join(',') : '',
      },
      body: JSON.stringify(delivery.packet),
    }).then((r) => r.json());

    return res;
  }
}
