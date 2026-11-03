import crypto from 'node:crypto';
import { serverKeyHolder } from '../config/serverKeys.js';

export const RSA_ENCRYPTED_KEY_BYTES = 256; // 2048-bit RSA produces 256 bytes
export const GCM_IV_BYTES = 12;            // 96-bit IV
export const GCM_TAG_BYTES = 16;           // 128-bit GCM auth tag
export const MIN_CIPHERTEXT_BYTES = RSA_ENCRYPTED_KEY_BYTES + GCM_IV_BYTES + GCM_TAG_BYTES; // 284 bytes

/**
 * Encrypt a PaymentInstruction with the server's public key using hybrid encryption.
 * Wire format (Base64 encoded):
 *   [ 256 bytes RSA-OAEP encrypted AES key ][ 12 bytes IV ][ AES ciphertext ][ 16 bytes GCM auth tag ]
 *
 * @param {object} instruction PaymentInstruction JSON object
 * @param {crypto.KeyObject|string} [publicKey] Server's public key (KeyObject or Base64 SPKI DER)
 * @returns {string} Base64 encoded hybrid ciphertext
 */
export function encrypt(instruction, publicKey) {
  const pubKey = resolvePublicKey(publicKey || serverKeyHolder.getPublicKey());
  const plaintext = Buffer.from(JSON.stringify(instruction), 'utf8');

  // 1. Generate one-time 256-bit AES key
  const aesKey = crypto.randomBytes(32);

  // 2. AES-256-GCM encrypt the payload
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const aesCipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const aesCiphertext = Buffer.concat([aesCipher.update(plaintext), aesCipher.final()]);
  const authTag = aesCipher.getAuthTag();

  // 3. RSA-OAEP encrypt the AES key with server's public key (SHA-256 hash & MGF1)
  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: pubKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );

  // 4. Pack: [encryptedAesKey (256B)][iv (12B)][aesCiphertext (NB)][authTag (16B)]
  const packed = Buffer.concat([encryptedAesKey, iv, aesCiphertext, authTag]);
  return packed.toString('base64');
}

/**
 * Decrypt a hybrid ciphertext with the server's private key.
 * Throws if the ciphertext has been modified or truncated (GCM auth tag verification failure).
 *
 * @param {string} base64Ciphertext Base64 encoded hybrid ciphertext
 * @param {crypto.KeyObject} [privateKey] Server's private key (defaults to serverKeyHolder)
 * @returns {object} Decrypted PaymentInstruction object
 */
export function decrypt(base64Ciphertext, privateKey) {
  const privKey = privateKey || serverKeyHolder.getPrivateKey();
  const all = Buffer.from(base64Ciphertext, 'base64');

  if (all.length < MIN_CIPHERTEXT_BYTES) {
    throw new Error('Ciphertext too short');
  }

  // Unpack wire format
  const encryptedAesKey = all.subarray(0, RSA_ENCRYPTED_KEY_BYTES);
  const iv = all.subarray(RSA_ENCRYPTED_KEY_BYTES, RSA_ENCRYPTED_KEY_BYTES + GCM_IV_BYTES);
  const aesCiphertext = all.subarray(
    RSA_ENCRYPTED_KEY_BYTES + GCM_IV_BYTES,
    all.length - GCM_TAG_BYTES
  );
  const authTag = all.subarray(all.length - GCM_TAG_BYTES);

  // 1. RSA-OAEP decrypt AES key
  const aesKey = crypto.privateDecrypt(
    {
      key: privKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    encryptedAesKey
  );

  // 2. AES-256-GCM decrypt payload and verify auth tag
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(aesCiphertext), decipher.final()]);

  return JSON.parse(plaintext.toString('utf8'));
}

/**
 * Computes SHA-256 hex digest of the Base64 ciphertext string.
 * This is the idempotency key, matching Java's sha256.digest(base64Ciphertext.getBytes()).
 *
 * @param {string} base64Ciphertext
 * @returns {string} 64-character lowercase hex digest
 */
export function hashCiphertext(base64Ciphertext) {
  return crypto.createHash('sha256').update(base64Ciphertext, 'utf8').digest('hex');
}

/**
 * SHA-256 helper for PIN hashing
 * @param {string} input
 * @returns {string} hex digest
 */
export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function resolvePublicKey(key) {
  if (typeof key === 'string') {
    return crypto.createPublicKey({
      key: Buffer.from(key, 'base64'),
      format: 'der',
      type: 'spki',
    });
  }
  return key;
}
