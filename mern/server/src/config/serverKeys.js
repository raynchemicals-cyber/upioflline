import crypto from 'node:crypto';

/**
 * Holds the server's RSA keypair.
 *
 * In production, the private key would live in an HSM (Hardware Security Module)
 * or KMS (AWS KMS, HashiCorp Vault). Never in code.
 *
 * Generates an in-memory 2048-bit RSA keypair on startup. The public key is
 * exposed via /api/server-key for simulated sender devices to encrypt payloads.
 */
class ServerKeyHolder {
  constructor() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    this.publicKeyBase64 = this.publicKeyDer.toString('base64');
  }

  getPublicKey() {
    return this.publicKey;
  }

  getPrivateKey() {
    return this.privateKey;
  }

  getPublicKeyBase64() {
    return this.publicKeyBase64;
  }
}

export const serverKeyHolder = new ServerKeyHolder();
