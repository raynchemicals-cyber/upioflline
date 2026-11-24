import fs from 'fs';
import path from 'path';
import { serverKeyHolder } from '../config/serverKeys.js';
import { demoService } from '../services/demoService.js';
import { meshSimulatorService } from '../services/meshSimulatorService.js';
import { bridgeIngestionService } from '../services/bridgeIngestionService.js';
import { idempotencyService } from '../services/idempotencyService.js';
import { metricsService } from '../services/metricsService.js';
import { Account } from '../models/Account.js';
import { Transaction } from '../models/Transaction.js';
import { FlaggedPayment } from '../models/FlaggedPayment.js';
import { RelayNode } from '../models/RelayNode.js';

export const apiController = {
  // ------------------------------------------------------------- Key
  getServerPublicKey(req, res) {
    res.json({
      publicKey: serverKeyHolder.getPublicKeyBase64(),
      algorithm: 'RSA-2048 / OAEP-SHA256',
      hybridScheme: 'RSA-OAEP encrypts an AES-256-GCM session key',
    });
  },

  // ------------------------------------------------------------ Demo
  async demoSend(req, res, next) {
    try {
      const { senderVpa, receiverVpa, amount, pin, ttl = 5, startDevice = 'phone-alice' } = req.body;
      const packet = demoService.createPacket(senderVpa, receiverVpa, amount, pin, ttl);

      meshSimulatorService.inject(startDevice, packet);
      metricsService.recordSent();

      res.json({
        packetId: packet.packetId,
        ciphertextPreview: packet.ciphertext.substring(0, 64) + '...',
        ttl: packet.ttl,
        injectedAt: startDevice,
        packet,
      });
    } catch (err) {
      next(err);
    }
  },

  // -------------------------------------------------------- Mesh Sim
  meshState(req, res) {
    const devices = meshSimulatorService.getDevices().map((d) => ({
      deviceId: d.deviceId,
      hasInternet: d.hasInternet,
      packetCount: d.packetCount(),
      packetIds: d.getHeldPackets().map((p) => p.packetId.substring(0, 8)),
    }));

    res.json({
      devices,
      idempotencyCacheSize: idempotencyService.size(),
    });
  },

  meshGossip(req, res) {
    const r = meshSimulatorService.gossipOnce();
    res.json({
      transfers: r.transfers,
      deviceCounts: r.deviceCounts,
    });
  },

  async meshFlush(req, res, next) {
    try {
      const uploads = meshSimulatorService.collectBridgeUploads();

      // Parallel execution to exercise concurrent idempotency
      const results = await Promise.all(
        uploads.map(async (up) => {
          const hopCount = 5 - up.packet.ttl;
          const r = await bridgeIngestionService.ingest(up.packet, up.bridgeNodeId, hopCount);
          return {
            bridgeNode: up.bridgeNodeId,
            packetId: up.packet.packetId.substring(0, 8),
            outcome: r.outcome,
            reason: r.reason || '',
            transactionId: r.transactionId ?? -1,
          };
        })
      );

      res.json({
        uploadsAttempted: uploads.length,
        results,
      });
    } catch (err) {
      next(err);
    }
  },

  async meshReset(req, res, next) {
    try {
      meshSimulatorService.resetMesh();
      idempotencyService.clear();
      await Account.deleteMany({});
      await Transaction.deleteMany({});
      await FlaggedPayment.deleteMany({});
      await demoService.seedAccounts();
      res.json({ status: 'mesh, idempotency cache, and demo accounts reset' });
    } catch (err) {
      next(err);
    }
  },

  // ---------------------------------------------------------- Bridge
  async ingest(req, res, next) {
    try {
      const bridgeNodeId = req.headers['x-bridge-node-id'] || 'unknown';
      const hopCountHeader = req.headers['x-hop-count'];
      const hopCount = hopCountHeader ? parseInt(hopCountHeader, 10) : 0;
      const relayNodesHeader = req.headers['x-relay-nodes'];
      const relayNodes = relayNodesHeader
        ? relayNodesHeader.split(',').map((s) => s.trim())
        : [];

      const result = await bridgeIngestionService.ingest(
        req.body,
        bridgeNodeId,
        hopCount,
        relayNodes
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },

  // -------------------------------------------------------- Accounts
  async listAccounts(req, res, next) {
    try {
      const accounts = await Account.find();
      res.json(accounts);
    } catch (err) {
      next(err);
    }
  },

  async listTransactions(req, res, next) {
    try {
      const transactions = await Transaction.find().sort({ _id: -1 }).limit(20);
      res.json(transactions);
    } catch (err) {
      next(err);
    }
  },

  // ---------------------------------------------------- AI Risk Queue
  async listFlagged(req, res, next) {
    try {
      const flagged = await FlaggedPayment.find({ status: 'PENDING_REVIEW' }).sort({ _id: -1 });
      res.json(flagged);
    } catch (err) {
      next(err);
    }
  },

  async reviewFlagged(req, res, next) {
    try {
      const { id } = req.params;
      const { decision } = req.body;
      const result = await bridgeIngestionService.reviewFlaggedPayment(id, decision);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },

  // ----------------------------------------------------------- Metrics
  getMetrics(req, res) {
    res.json(metricsService.getSnapshot());
  },

  getMetricsStream(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();

    // Send initial snapshot immediately
    res.write(`data: ${JSON.stringify(metricsService.getSnapshot())}\n\n`);

    const unsubscribe = metricsService.subscribe((snapshot) => {
      try {
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      } catch {}
    });

    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {}
    }, 15000);

    req.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  },

  // ------------------------------------------------------- Relay Nodes
  async listRelayNodes(req, res, next) {
    try {
      let relays = await RelayNode.find().sort({ nodeId: 1 });
      if (!relays || relays.length === 0) {
        // Fallback to active simulator devices if DB is unseeded
        const devices = meshSimulatorService.getDevices();
        relays = devices.map((d) => ({
          nodeId: d.deviceId,
          trustScore: d.deviceId.includes('rogue') ? 25 : 80,
          classification: d.deviceId.includes('rogue') ? 'MALICIOUS' : 'HONEST',
          reputation: d.deviceId.includes('rogue') ? 25 : 80,
          totalRelayed: d.packetCount(),
          invalidRelayed: d.deviceId.includes('rogue') ? 1 : 0,
          forwardedOk: d.packetCount(),
          drops: 0,
          lastEventAt: new Date(),
        }));
      }
      res.json(relays);
    } catch (err) {
      next(err);
    }
  },

  // -------------------------------------------------- Experiment Results
  getExperimentResult(req, res) {
    const { id } = req.params;
    const paths = [
      path.resolve(process.cwd(), '..', 'simulator', 'results', `exp_${id}.json`),
      path.resolve(process.cwd(), 'results', `exp_${id}.json`),
      path.resolve(process.cwd(), '..', 'results', `exp_${id}.json`),
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        try {
          const data = JSON.parse(fs.readFileSync(p, 'utf8'));
          return res.json(data);
        } catch {}
      }
    }
    res.status(404).json({ error: `Experiment result for ${id} not found` });
  },
};
