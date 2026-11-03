import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { Account } from '../src/models/Account.js';
import { Transaction } from '../src/models/Transaction.js';
import { FlaggedPayment } from '../src/models/FlaggedPayment.js';
import { RelayNode } from '../src/models/RelayNode.js';
import { demoService } from '../src/services/demoService.js';
import { idempotencyService } from '../src/services/idempotencyService.js';
import { riskScoringService } from '../src/services/riskScoringService.js';

describe('UPI Offline Mesh Pipeline & Concurrency Suite', () => {
  let app;

  beforeAll(async () => {
    await connectDb();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  beforeEach(async () => {
    await Account.deleteMany({});
    await Transaction.deleteMany({});
    await FlaggedPayment.deleteMany({});
    await RelayNode.deleteMany({});
    idempotencyService.clear();
    riskScoringService.clearVelocityHistory();

    // Seed baseline accounts
    await Account.create([
      { vpa: 'alice@demo', holderName: 'Alice', balance: 5000.0 },
      { vpa: 'bob@demo', holderName: 'Bob', balance: 1000.0 },
      { vpa: 'carol@demo', holderName: 'Carol', balance: 2500.0 },
      { vpa: 'dave@demo', holderName: 'Dave', balance: 500.0 },
    ]);
  });

  it('settles a normal payment correctly through /api/bridge/ingest', async () => {
    const packet = demoService.createPacket('alice@demo', 'bob@demo', 100.0, '1234', 5);

    const res = await request(app)
      .post('/api/bridge/ingest')
      .set('X-Bridge-Node-Id', 'phone-bridge-1')
      .set('X-Hop-Count', '2')
      .send(packet);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('SETTLED');
    expect(typeof res.body.transactionId).toBe('number');

    const alice = await Account.findOne({ vpa: 'alice@demo' });
    const bob = await Account.findOne({ vpa: 'bob@demo' });
    expect(alice.balance).toBe(4900.0);
    expect(bob.balance).toBe(1100.0);
  });

  it('Step 4 Concurrency Test: 10 bridge nodes firing the same packet simultaneously settle EXACTLY ONCE', async () => {
    const initialAlice = await Account.findOne({ vpa: 'alice@demo' });
    const initialBob = await Account.findOne({ vpa: 'bob@demo' });

    const packet = demoService.createPacket('alice@demo', 'bob@demo', 250.0, '1234', 5);

    // Fire 10 concurrent requests at /api/bridge/ingest with different bridge node IDs
    const concurrentRequests = Array.from({ length: 10 }, (_, i) =>
      request(app)
        .post('/api/bridge/ingest')
        .set('X-Bridge-Node-Id', `phone-bridge-${i}`)
        .set('X-Hop-Count', '2')
        .send(packet)
    );

    const responses = await Promise.all(concurrentRequests);

    const outcomes = responses.map((r) => r.body.outcome);
    const settledCount = outcomes.filter((o) => o === 'SETTLED').length;
    const duplicateCount = outcomes.filter((o) => o === 'DUPLICATE_DROPPED').length;

    expect(settledCount).toBe(1);
    expect(duplicateCount).toBe(9);

    // Verify balances changed by exactly the transfer amount ONCE
    const finalAlice = await Account.findOne({ vpa: 'alice@demo' });
    const finalBob = await Account.findOne({ vpa: 'bob@demo' });
    expect(finalAlice.balance).toBe(initialAlice.balance - 250.0);
    expect(finalBob.balance).toBe(initialBob.balance + 250.0);

    // Verify ledger has exactly 1 entry for this packetHash
    const txCount = await Transaction.countDocuments({ packetHash: responses[0].body.packetHash });
    expect(txCount).toBe(1);
  });

  it('rejects tampered ciphertext with INVALID outcome and penalizes relay', async () => {
    const packet = demoService.createPacket('alice@demo', 'bob@demo', 50.0, '1234', 5);

    // Corrupt ciphertext
    const buf = Buffer.from(packet.ciphertext, 'base64');
    buf[270] ^= 0xff;
    packet.ciphertext = buf.toString('base64');

    const res = await request(app)
      .post('/api/bridge/ingest')
      .set('X-Bridge-Node-Id', 'bad-relay-1')
      .set('X-Hop-Count', '2')
      .send(packet);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('INVALID');
    expect(res.body.reason).toBe('decryption_failed');

    // Balance untouched
    const alice = await Account.findOne({ vpa: 'alice@demo' });
    expect(alice.balance).toBe(5000.0);

    // Verify relay reputation was penalized
    const relay = await RelayNode.findOne({ nodeId: 'bad-relay-1' });
    expect(relay).not.toBeNull();
    expect(relay.reputation).toBeLessThan(100);
    expect(relay.invalidRelayed).toBe(1);
  });

  it('rejects stale packets older than 24 hours (replay protection)', async () => {
    // 25 hours old timestamp
    const staleTime = Date.now() - 25 * 3600 * 1000;
    const packet = demoService.createPacket('alice@demo', 'bob@demo', 50.0, '1234', 5, staleTime);

    const res = await request(app)
      .post('/api/bridge/ingest')
      .set('X-Bridge-Node-Id', 'phone-bridge-1')
      .send(packet);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('INVALID');
    expect(res.body.reason).toBe('stale_packet');
  });

  it('rejects future-dated packets (clock skew protection)', async () => {
    // 10 minutes into the future
    const futureTime = Date.now() + 10 * 60 * 1000;
    const packet = demoService.createPacket('alice@demo', 'bob@demo', 50.0, '1234', 5, futureTime);

    const res = await request(app)
      .post('/api/bridge/ingest')
      .set('X-Bridge-Node-Id', 'phone-bridge-1')
      .send(packet);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('INVALID');
    expect(res.body.reason).toBe('future_dated');
  });

  it('Step 5 AI Risk Scoring: flags suspicious high-risk payment and permits review approval', async () => {
    // Inject abnormal signals: 8 hops, high amount, compromised relay
    await RelayNode.create({ nodeId: 'sketchy-relay', reputation: 30 });

    const packet = demoService.createPacket('alice@demo', 'bob@demo', 4500.0, '1234', 1);

    const res = await request(app)
      .post('/api/bridge/ingest')
      .set('X-Bridge-Node-Id', 'phone-bridge-1')
      .set('X-Hop-Count', '8')
      .set('X-Relay-Nodes', 'sketchy-relay')
      .send(packet);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('FLAGGED');
    expect(res.body.reason).toBe('risk_score_exceeded');
    expect(res.body.riskScore).toBeGreaterThanOrEqual(50);
    expect(Array.isArray(res.body.contributingFactors)).toBe(true);
    expect(res.body.contributingFactors.length).toBeGreaterThan(0);

    // Ensure payment did NOT settle yet
    const alice = await Account.findOne({ vpa: 'alice@demo' });
    expect(alice.balance).toBe(5000.0);

    // Verify it is stored in flagged_payments collection
    const flaggedListRes = await request(app).get('/api/flagged');
    expect(flaggedListRes.status).toBe(200);
    expect(flaggedListRes.body.length).toBe(1);
    const flaggedId = flaggedListRes.body[0].id || flaggedListRes.body[0]._id;

    // Review & approve payment
    const reviewRes = await request(app)
      .post(`/api/flagged/${flaggedId}/review`)
      .send({ decision: 'approve' });

    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.outcome).toBe('SETTLED');

    // Balance moved after human approval
    const finalAlice = await Account.findOne({ vpa: 'alice@demo' });
    expect(finalAlice.balance).toBe(500.0);
  });
});
