import { describe, it, expect } from '@jest/globals';
import {
  encrypt,
  decrypt,
  hashCiphertext,
  sha256Hex,
  MIN_CIPHERTEXT_BYTES,
  RSA_ENCRYPTED_KEY_BYTES,
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
} from '../src/utils/crypto.js';
import { serverKeyHolder } from '../src/config/serverKeys.js';
import crypto from 'node:crypto';

describe('Crypto Utility - Pure Node.js Hybrid Encryption', () => {
  const sampleInstruction = {
    senderVpa: 'alice@demo',
    receiverVpa: 'bob@demo',
    amount: 500.0,
    pinHash: sha256Hex('1234'),
    nonce: '550e8400-e29b-41d4-a716-446655440000',
    signedAt: 1730000000000,
  };

  it('performs encrypt/decrypt round trip matching all fields', () => {
    const ciphertext = encrypt(sampleInstruction);
    expect(typeof ciphertext).toBe('string');

    const decrypted = decrypt(ciphertext);
    expect(decrypted.senderVpa).toBe(sampleInstruction.senderVpa);
    expect(decrypted.receiverVpa).toBe(sampleInstruction.receiverVpa);
    expect(decrypted.amount).toBe(sampleInstruction.amount);
    expect(decrypted.pinHash).toBe(sampleInstruction.pinHash);
    expect(decrypted.nonce).toBe(sampleInstruction.nonce);
    expect(decrypted.signedAt).toBe(sampleInstruction.signedAt);
  });

  it('matches the exact Java wire binary layout byte-for-byte', () => {
    const ciphertext = encrypt(sampleInstruction);
    const wireBuffer = Buffer.from(ciphertext, 'base64');

    const plaintextBytes = Buffer.from(JSON.stringify(sampleInstruction), 'utf8');
    const expectedLength =
      RSA_ENCRYPTED_KEY_BYTES + GCM_IV_BYTES + plaintextBytes.length + GCM_TAG_BYTES;

    expect(wireBuffer.length).toBe(expectedLength);
    expect(wireBuffer.length).toBeGreaterThanOrEqual(MIN_CIPHERTEXT_BYTES);

    // Extract segments
    const encryptedKey = wireBuffer.subarray(0, 256);
    const iv = wireBuffer.subarray(256, 268);
    const rawAesCiphertext = wireBuffer.subarray(268, wireBuffer.length - 16);
    const authTag = wireBuffer.subarray(wireBuffer.length - 16);

    expect(encryptedKey.length).toBe(256);
    expect(iv.length).toBe(12);
    expect(rawAesCiphertext.length).toBe(plaintextBytes.length);
    expect(authTag.length).toBe(16);

    // Verify RSA-OAEP decrypts key successfully
    const aesKey = crypto.privateDecrypt(
      {
        key: serverKeyHolder.getPrivateKey(),
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      encryptedKey
    );
    expect(aesKey.length).toBe(32); // 256-bit AES key

    // Verify AES-GCM decrypts with tag
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(rawAesCiphertext), decipher.final()]);
    expect(JSON.parse(decrypted.toString('utf8'))).toEqual(sampleInstruction);
  });

  it('rejects tampered ciphertext with GCM authentication exception', () => {
    const ciphertext = encrypt(sampleInstruction);
    const buffer = Buffer.from(ciphertext, 'base64');

    // Flip a byte in the AES ciphertext portion
    buffer[275] ^= 0xff;
    const tamperedBase64 = buffer.toString('base64');

    expect(() => {
      decrypt(tamperedBase64);
    }).toThrow();
  });

  it('rejects tampered auth tag', () => {
    const ciphertext = encrypt(sampleInstruction);
    const buffer = Buffer.from(ciphertext, 'base64');

    // Flip a byte in the 16-byte auth tag at the end
    buffer[buffer.length - 1] ^= 0x01;
    const tamperedBase64 = buffer.toString('base64');

    expect(() => {
      decrypt(tamperedBase64);
    }).toThrow();
  });

  it('rejects ciphertext that is too short', () => {
    const shortBuffer = Buffer.alloc(100);
    const shortBase64 = shortBuffer.toString('base64');

    expect(() => {
      decrypt(shortBase64);
    }).toThrow('Ciphertext too short');
  });

  it('computes sha256 hex digest of base64 string matching Java contract', () => {
    const ciphertext = encrypt(sampleInstruction);
    const hash = hashCiphertext(ciphertext);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    const manualSha = crypto.createHash('sha256').update(ciphertext, 'utf8').digest('hex');
    expect(hash).toBe(manualSha);
  });

  it('exports Base64 SPKI public key compatible with standard RSA loaders', () => {
    const pubKeyBase64 = serverKeyHolder.getPublicKeyBase64();
    expect(typeof pubKeyBase64).toBe('string');

    const imported = crypto.createPublicKey({
      key: Buffer.from(pubKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(imported.asymmetricKeyType).toBe('rsa');
  });
});
