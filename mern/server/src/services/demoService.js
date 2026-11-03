import crypto from 'node:crypto';
import { Account } from '../models/Account.js';
import { encrypt, sha256Hex } from '../utils/crypto.js';
import { serverKeyHolder } from '../config/serverKeys.js';

export class DemoService {
  /**
   * Seeds 4 initial demo accounts if the collection is empty.
   */
  async seedAccounts() {
    const count = await Account.countDocuments();
    if (count === 0) {
      await Account.create([
        { vpa: 'alice@demo', holderName: 'Alice', balance: 5000.0 },
        { vpa: 'bob@demo', holderName: 'Bob', balance: 1000.0 },
        { vpa: 'carol@demo', holderName: 'Carol', balance: 2500.0 },
        { vpa: 'dave@demo', holderName: 'Dave', balance: 500.0 },
      ]);
      console.log('Seeded 4 demo accounts: alice@demo, bob@demo, carol@demo, dave@demo');
    }
  }

  /**
   * Simulates the sender phone offline creation of an encrypted MeshPacket.
   *
   * @param {string} senderVpa
   * @param {string} receiverVpa
   * @param {number} amount
   * @param {string} pin
   * @param {number} [ttl=5]
   * @param {number} [timestamp] Optional custom timestamp for testing replay/freshness
   * @returns {object} MeshPacket { packetId, ttl, createdAt, ciphertext }
   */
  createPacket(senderVpa, receiverVpa, amount, pin = '1234', ttl = 5, timestamp = null) {
    const signedAt = timestamp || Date.now();
    const instruction = {
      senderVpa,
      receiverVpa,
      amount: Number(amount),
      pinHash: sha256Hex(pin),
      nonce: crypto.randomUUID(),
      signedAt,
    };

    const ciphertext = encrypt(instruction, serverKeyHolder.getPublicKey());

    return {
      packetId: crypto.randomUUID(),
      ttl,
      createdAt: signedAt,
      ciphertext,
    };
  }
}

export const demoService = new DemoService();
