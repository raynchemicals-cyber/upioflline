# UPI Offline Mesh: Spring Boot to MERN Migration Plan

This document details the analysis of the Java Spring Boot reference implementation in `my-project/` and defines the architecture, cryptographic contracts, component mappings, and migration strategy for the target MERN stack implementation in `/mern`.

---

## 1. Inventory of Existing Spring Boot Codebase

### Controllers
| Class | Annotations | Routes / Handlers | Description |
|---|---|---|---|
| `com.demo.upimesh.controller.ApiController` | `@RestController`, `@RequestMapping("/api")` | `GET /api/server-key`<br>`POST /api/demo/send`<br>`GET /api/mesh/state`<br>`POST /api/mesh/gossip`<br>`POST /api/mesh/flush`<br>`POST /api/mesh/reset`<br>`POST /api/bridge/ingest`<br>`GET /api/accounts`<br>`GET /api/transactions` | REST surface exposing server public key, simulator controls, account/ledger queries, and the production bridge ingestion pipeline endpoint. |
| `com.demo.upimesh.controller.DashboardController` | `@Controller` | `GET /` | Serves the server-rendered Thymeleaf demo dashboard (`dashboard.html`). |

### Services & Business Logic
| Class | Annotations | Responsibility |
|---|---|---|
| `com.demo.upimesh.crypto.ServerKeyHolder` | `@Component` | Generates a 2048-bit RSA keypair on startup (`@PostConstruct`) using `KeyPairGenerator.getInstance("RSA")`. Exposes the Base64-encoded X.509 SPKI public key and RSA private key. |
| `com.demo.upimesh.crypto.HybridCryptoService` | `@Service` | Implements hybrid encryption (`RSA-OAEP` + `AES-256-GCM`). Generates a fresh AES-256 key per packet, encrypts payload, encrypts AES key with server's RSA public key, packs wire binary, decrypts and verifies GCM tag, and computes SHA-256 hex of the Base64 ciphertext. |
| `com.demo.upimesh.service.IdempotencyService` | `@Service` | Thread-safe, in-memory idempotency cache using `ConcurrentHashMap<String, Instant>`. Provides atomic `claim(packetHash)` via `putIfAbsent`. Runs scheduled eviction for entries older than `ttlSeconds` (default: 86,400s). |
| `com.demo.upimesh.service.SettlementService` | `@Service` | Performs ledger updates under `@Transactional`. Verifies sender and receiver accounts, validates positive balance, decrements sender balance, increments receiver balance, inserts settled or rejected record in `transactions` table. Uses `@Version` optimistic locking on `Account`. |
| `com.demo.upimesh.service.BridgeIngestionService` | `@Service` | Core ingestion orchestrator: (1) Computes SHA-256 hash of ciphertext; (2) Atomically checks/claims hash in `IdempotencyService`; (3) Decrypts payload with `HybridCryptoService`; (4) Enforces freshness window (`signedAt` within 24 hours, tolerating clock-skew down to -300s); (5) Delegates to `SettlementService`. Returns `IngestResult`. |
| `com.demo.upimesh.service.DemoService` | `@Service` | Seeds 4 initial accounts (`alice@demo`: ₹5000, `bob@demo`: ₹1000, `carol@demo`: ₹2500, `dave@demo`: ₹500) via `@PostConstruct`. Helper `createPacket()` simulates a sender phone by creating a `PaymentInstruction` with nonce, hashing PIN with SHA-256, encrypting, and wrapping into a `MeshPacket`. |
| `com.demo.upimesh.service.MeshSimulatorService` | `@Service` | In-memory mesh network simulator holding `VirtualDevice` instances (`phone-alice`, `phone-stranger1..3`, `phone-bridge`). Simulates `inject()`, pairwise gossip with TTL decrement (`gossipOnce()`), collecting bridge uploads for devices with `hasInternet=true` (`collectBridgeUploads()`), and mesh reset. |
| `com.demo.upimesh.service.VirtualDevice` | Plain POJO | Represents an individual phone node holding a collection of `MeshPacket`s by `packetId`, and an internet connectivity flag (`hasInternet`). |

### Entities & Database Layer
| Class | Annotations | Database Mapping | Key Attributes |
|---|---|---|---|
| `com.demo.upimesh.model.Account` | `@Entity`, `@Table(name = "accounts")` | Table `accounts` | `vpa` (String, `@Id`), `holderName` (String), `balance` (`BigDecimal(19, 2)`), `version` (`@Version Long` optimistic lock). |
| `com.demo.upimesh.model.Transaction` | `@Entity`, `@Table(name = "transactions")` | Table `transactions` with unique index `idx_packet_hash` on `packetHash` | `id` (Long `@GeneratedValue`), `packetHash` (String, unique, length 64), `senderVpa`, `receiverVpa`, `amount` (`BigDecimal(19,2)`), `signedAt` (`Instant`), `settledAt` (`Instant`), `bridgeNodeId` (String), `hopCount` (int), `status` (Enum `SETTLED`, `REJECTED`). |

### Repositories
| Interface | Base Type | Custom Query Methods |
|---|---|---|
| `com.demo.upimesh.model.AccountRepository` | `JpaRepository<Account, String>` | Default Spring Data JPA CRUD (`findById`, `save`, `count`, `findAll`). |
| `com.demo.upimesh.model.TransactionRepository` | `JpaRepository<Transaction, Long>` | `findTop20ByOrderByIdDesc()`, `existsByPacketHash(String packetHash)`. |

### DTOs & Domain Models
| Class | Role | Fields |
|---|---|---|
| `com.demo.upimesh.model.MeshPacket` | Over-the-wire packet | `packetId` (UUID string), `ttl` (int), `createdAt` (Long epoch ms), `ciphertext` (Base64 string). |
| `com.demo.upimesh.model.PaymentInstruction` | Decrypted plaintext payload | `senderVpa` (String), `receiverVpa` (String), `amount` (`BigDecimal`), `pinHash` (String SHA-256), `nonce` (UUID string), `signedAt` (Long epoch ms). |
| `ApiController.DemoSendRequest` | Request DTO for `/api/demo/send` | `senderVpa`, `receiverVpa`, `amount`, `pin`, `ttl`, `startDevice`. |
| `BridgeIngestionService.IngestResult` | Response record for ingestion | `outcome` (`SETTLED` \| `DUPLICATE_DROPPED` \| `INVALID`), `packetHash` (String), `reason` (String), `transactionId` (Long). |
| `MeshSimulatorService.GossipResult` | Response record for `/api/mesh/gossip` | `transfers` (int), `deviceCounts` (Map<String, Integer>). |
| `MeshSimulatorService.BridgeUpload` | Internal DTO for bridge uploads | `bridgeNodeId` (String), `packet` (`MeshPacket`). |

### Configurations & Schedulers
| File / Class | Annotations / Directives | Configuration Details |
|---|---|---|
| `com.demo.upimesh.config.AppConfig` | `@Configuration`, `@EnableScheduling` | Enables Spring background scheduling for eviction. |
| `src/main/resources/application.properties` | Spring properties | `server.port=8080`<br>`spring.datasource.url=jdbc:h2:mem:upimesh`<br>`spring.h2.console.enabled=true`<br>`upi.mesh.idempotency-ttl-seconds=86400`<br>`upi.mesh.packet-max-age-seconds=86400` |
| `IdempotencyService.evictExpired()` | `@Scheduled(fixedDelay = 60_000)` | Periodic eviction task running every 60 seconds to prune entries past the 24h TTL. |

### Tests
| Class | Framework | Test Methods |
|---|---|---|
| `com.demo.upimesh.IdempotencyConcurrencyTest` | JUnit 5 + Spring Boot Test | `singlePacketDeliveredByThreeBridgesSettlesExactlyOnce()`: Concurrently posts identical packet from 3 worker threads, asserts exactly 1 settled, 2 duplicates, single debit.<br>`tamperedCiphertextIsRejected()`: Flips a character in ciphertext, asserts `INVALID` outcome.<br>`encryptDecryptRoundTrip()`: Verifies symmetric encryption/decryption consistency of `PaymentInstruction`. |

---

## 2. Spring Component to MERN Equivalent Mapping Table

| Spring Boot Component | Target MERN Equivalent | Location in `/mern` | Key Notes & Architectural Equivalent |
|---|---|---|---|
| `UpiMeshApplication.java` | Node.js Express server entry point | `/mern/server/src/server.js` | Initializes Express, connects to MongoDB, mounts middleware & routers, boots background jobs. |
| `application.properties` | `.env` managed via `dotenv` | `/mern/server/.env` (and `.env.example`) | Port, MongoDB URI, TTLs, AI scoring thresholds, JWT/keys if needed. |
| `AppConfig.java` / `@Scheduled` | `setInterval` or `node-cron` | `/mern/server/src/services/idempotencyService.js` | Periodic eviction timer running every 60s. |
| `ApiController.java` | Express Router & Controllers | `/mern/server/src/routes/api.js`<br>`/mern/server/src/controllers/apiController.js` | Identical paths (`/api/*`), HTTP verbs, query/body params, status codes, and JSON response shapes. |
| `DashboardController.java` & `dashboard.html` | React Single Page App (Vite) | `/mern/client` | High-fidelity React dashboard with live mesh graph, settlement feed, risk queue, and simulator controls. |
| Bean Validation (`@NotNull`, `@NotBlank`) | Validation Middleware (Zod) | `/mern/server/src/middleware/validate.js` | Validates `MeshPacket`, `DemoSendRequest`, header schemas before controllers execute. |
| `@ControllerAdvice` / Exception Handlers | Express Central Error Handler | `/mern/server/src/middleware/errorHandler.js` | Catches unhandled errors, formats consistent JSON responses. |
| `Account.java` (JPA Entity) | Mongoose Schema & Model | `/mern/server/src/models/Account.js` | Fields: `vpa` (unique index / string ID), `holderName`, `balance` (Decimal128/Number), `version` (Number for optimistic locking). |
| `Transaction.java` (JPA Entity) | Mongoose Schema & Model | `/mern/server/src/models/Transaction.js` | Fields: `packetHash` (unique index), `senderVpa`, `receiverVpa`, `amount`, `signedAt`, `settledAt`, `bridgeNodeId`, `hopCount`, `status`. |
| `AccountRepository.java` | Mongoose Model Methods | `/mern/server/src/models/Account.js` | Direct query helpers on `Account` model. |
| `TransactionRepository.java` | Mongoose Model Methods | `/mern/server/src/models/Transaction.js` | Direct query helpers on `Transaction` model (`find().sort({ _id: -1 }).limit(20)`). |
| `ServerKeyHolder.java` | Key Management Module | `/mern/server/src/config/serverKeys.js` | Generates RSA-2048 keypair on startup using Node built-in `crypto.generateKeyPairSync`, exports Base64 SPKI public key. |
| `HybridCryptoService.java` | Crypto Utility Module | `/mern/server/src/utils/crypto.js` | Pure Node.js `crypto` implementation conforming byte-for-byte with the Java contract. |
| `IdempotencyService.java` | Idempotency Service | `/mern/server/src/services/idempotencyService.js` | In-memory atomic cache + MongoDB unique index and atomic upsert/status tracking. |
| `SettlementService.java` | Settlement Service | `/mern/server/src/services/settlementService.js` | Executes balance updates and transaction insertion; supports MongoDB multi-document transactions where replica set is available, with atomic fallback for standalone instances. |
| `BridgeIngestionService.java` | Bridge Ingestion Pipeline | `/mern/server/src/services/bridgeIngestionService.js` | Hash -> Idempotency -> Decrypt -> Replay Check -> **AI Risk Scoring (Step 5)** -> Settle. |
| `DemoService.java` | Demo & Seed Service | `/mern/server/src/services/demoService.js` | Seeds demo accounts on startup; creates encrypted demo packets. |
| `MeshSimulatorService.java` & `VirtualDevice.java` | In-memory Mesh Simulator & Service | `/mern/server/src/services/meshSimulatorService.js` & `/mern/simulator` | Preserves `/api/mesh/*` endpoints while powering real-time simulation with WebSocket/SSE event push to the client. |
| *New Feature* | AI Fraud / Risk Scoring Engine | `/mern/server/src/services/riskScoringService.js` | Node.js unsupervised anomaly detection + weighted heuristic rules. Flagged payments collection & review endpoints. |
| `IdempotencyConcurrencyTest.java` | Jest + Supertest Test Suite | `/mern/server/tests/idempotency.concurrency.test.js`<br>`/mern/server/tests/crypto.test.js` | 10-concurrent-bridge tests, crypto roundtrip, tamper rejection, replay checks, AI risk tests. |

---

## 3. Cryptographic Contract (Byte-for-Byte Wire Compatibility)

The Node.js implementation must strictly adhere to the following contract using **Node.js built-in `crypto` only** (no third-party crypto packages):

### RSA Parameters
- **Algorithm**: RSA (`2048` bits key size / 256 bytes modulus).
- **Public Key Encoding**: SubjectPublicKeyInfo (SPKI) in DER format, Base64 encoded.
- **Private Key Encoding**: PKCS#8 in DER format.
- **Padding Transformation**: `RSA/ECB/OAEPWithSHA-256AndMGF1Padding`.
- **Node `crypto` equivalent**:
  - Encrypt: `crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKeyBuffer)`
  - Decrypt: `crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, encryptedAesKeyBuffer)`
  - In Node.js, specifying `oaepHash: 'sha256'` automatically configures both OAEP and MGF1 to use SHA-256, matching Java's `OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)`.
- **Encrypted AES Key Output Length**: Exactly 256 bytes.

### AES Parameters
- **Algorithm**: AES-256-GCM (`AES/GCM/NoPadding`).
- **Key Generation**: 256-bit (32 bytes) random secret key per packet (`crypto.randomBytes(32)`).
- **IV Length**: 12 bytes (`96` bits) generated via `crypto.randomBytes(12)`.
- **Authentication Tag Length**: 128 bits (16 bytes).

### Binary Wire Format & Authentication Tag Location
Java's SunJCE provider concatenates the 16-byte GCM authentication tag onto the end of the ciphertext returned by `aes.doFinal(plaintext)`. Conversely, Node.js `cipher.update() + cipher.final()` produces the raw ciphertext without the tag, exposing the tag via `cipher.getAuthTag()`.

The wire binary structure (before Base64 encoding) is:
```
+---------------------------+-------------------+----------------------------+-------------------+
| RSA Encrypted AES Key     | AES-GCM IV        | AES Raw Ciphertext         | GCM Auth Tag      |
| (256 bytes)               | (12 bytes)        | (N bytes = plaintext size) | (16 bytes)        |
+---------------------------+-------------------+----------------------------+-------------------+
0                           256                 268                          268 + N             284 + N
```
- **Serialization (Node.js)**:
  `Buffer.concat([encryptedAesKey, iv, aesRawCiphertext, authTag]).toString('base64')`
- **Deserialization (Node.js)**:
  1. `buffer = Buffer.from(base64Ciphertext, 'base64')`
  2. Validate minimum length: `buffer.length >= 256 + 12 + 16 = 284 bytes`.
  3. Extract `encryptedAesKey = buffer.subarray(0, 256)`
  4. Extract `iv = buffer.subarray(256, 268)`
  5. Extract `aesRawCiphertext = buffer.subarray(268, buffer.length - 16)`
  6. Extract `authTag = buffer.subarray(buffer.length - 16)`
  7. Decrypt AES key with RSA private key.
  8. Initialize decipher with `crypto.createDecipheriv('aes-256-gcm', aesKey, iv)`, set tag via `decipher.setAuthTag(authTag)`, and decrypt `aesRawCiphertext`.

### Ciphertext Hash Computation
In `HybridCryptoService.java`:
```java
MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
byte[] hash = sha256.digest(base64Ciphertext.getBytes());
```
Crucially, Java hashes the **UTF-8 character bytes of the Base64 ciphertext string**, not the decoded binary buffer!
The Node.js equivalent is:
```js
crypto.createHash('sha256').update(base64Ciphertext, 'utf8').digest('hex')
```
This produces the exact 64-character lowercase hexadecimal hash.

### Packet & Payload Schemas
1. **Outer Packet (`MeshPacket`)**:
   ```json
   {
     "packetId": "550e8400-e29b-41d4-a716-446655440000",
     "ttl": 5,
     "createdAt": 1730000000000,
     "ciphertext": "<base64 encoded binary blob>"
   }
   ```
2. **Encrypted Payload (`PaymentInstruction`)**:
   ```json
   {
     "senderVpa": "alice@demo",
     "receiverVpa": "bob@demo",
     "amount": 500.00,
     "pinHash": "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
     "nonce": "550e8400-e29b-41d4-a716-446655440000",
     "signedAt": 1730000000000
   }
   ```

---

## 4. Idempotency, Replay Protection, and Tamper Checks

| Defense Layer | Location in Pipeline | Implementation Details | Target MERN Stack Design |
|---|---|---|---|
| **1. Ingestion Idempotency Gate** | `BridgeIngestionService.ingest()` (pre-decryption) | Computes `SHA-256` of `ciphertext`. Invokes `IdempotencyService.claim(packetHash)`. If already present, immediately aborts and returns `DUPLICATE_DROPPED` without wasting CPU on RSA decryption. | In-memory atomic Map or Redis SETNX pattern, coupled with atomic status tracking in MongoDB. |
| **2. Database Unique Constraint** | `Transaction.java` / DB index | `@Index(name = "idx_packet_hash", columnList = "packetHash", unique = true)` on `transactions`. If two concurrent requests slip past cache, the DB rejects the duplicate. | Unique compound index in MongoDB on `Transaction.packetHash` (`{ packetHash: 1 }, { unique: true }`). Concurrent writes trigger E11000 duplicate key error, safely handled as idempotent `DUPLICATE_DROPPED`. |
| **3. Account Balance Concurrency** | `Account.java` / `SettlementService.settle()` | `@Version` column on `Account` provides optimistic locking. If two transfers update an account concurrently, JPA raises `OptimisticLockException`. | Atomic MongoDB `$inc` operations with query conditions (e.g., `{ balance: { $gte: amount } }`) or multi-document ACID transactions with document versioning. |
| **4. Cryptographic Tamper Resistance** | `HybridCryptoService.decrypt()` | Minimum byte length check (`< 284` bytes). AES-GCM 128-bit authentication tag check. Any bit flip in ciphertext, IV, or wrapped key fails GCM tag authentication, throwing an exception handled as `INVALID` (`decryption_failed`). | Node.js `decipher.setAuthTag(authTag)` throws `Error: Unsupported state or unable to authenticate data`. Pipeline catches this and yields `{ outcome: 'INVALID', reason: 'decryption_failed' }`. |
| **5. Stale Packet Replay Check** | `BridgeIngestionService.ingest()` | Computes `ageSeconds = (now - signedAt) / 1000`. If `ageSeconds > maxAgeSeconds` (86,400s), returns `INVALID` (`stale_packet`). | Same formula in `bridgeIngestionService.js`. Rejects replay of captured historic packets past the 24-hour freshness window. |
| **6. Clock-Skew / Future-Dating Check** | `BridgeIngestionService.ingest()` | Computes `ageSeconds`. If `ageSeconds < -300` (sender timestamp more than 5 minutes into the future), returns `INVALID` (`future_dated`). | Identical check in Node.js pipeline. |
| **7. Payment Intent Nonce** | `PaymentInstruction.nonce` | Random UUID generated per payment intent. Even identical amounts sent consecutively generate distinct plaintexts, different AES keys, different ciphertexts, and unique hashes. | UUID v4 generated on sender side per transaction. |

---

## 5. Architectural Enhancements & Clarifications

### Step 4: Exactly-Once Settlement in MongoDB
- **Replica Set vs Standalone**: Multi-document transactions (`session.withTransaction`) require a MongoDB replica set. In local standalone environments, transactions fail with `Transaction numbers are only allowed on a storage engine supporting replica sets`.
- **Hybrid Strategy**:
  1. We will implement transaction support (`withTransaction`) for replica set deployments.
  2. For standalone instances or testing without replica sets, we will use atomic two-phase updates:
     - Atomic insert of `Transaction` with unique `packetHash`.
     - Atomic balance `$inc` on sender `{ vpa: senderVpa, balance: { $gte: amount } }` and receiver `{ vpa: receiverVpa }`.
     - Graceful duplicate key catch (`error.code === 11000`) returning `{ outcome: 'DUPLICATE_DROPPED', packetHash }`.

### Step 5: AI Fraud / Risk Scoring
- **Pipeline Insertion Point**:
  `BridgeIngestionService`:
  ```
  Hash Ciphertext -> Idempotency Check -> Decrypt & Auth Tag -> Freshness Check
    -> [AI FRAUD & RISK SCORING]
       - If score >= threshold: Insert into flagged_payments, DO NOT SETTLE.
       - If score < threshold: Proceed to Settlement.
  ```
- **Risk Signals**:
  1. `hopCount`: Excessive hops compared to network diameter.
  2. `latencySeconds`: Elapsed time between packet creation and bridge ingestion.
  3. `senderVelocity`: Count of offline payments sent by this VPA without intervening backend sync.
  4. `amountDeviation`: Z-score / ratio compared to sender's historical average amount.
  5. `relayReputation`: Aggregated reputation of intermediate nodes; penalized if a node repeatedly relays invalid/tampered packets.
- **Model**: Pure JavaScript Unsupervised Anomaly Detection (Isolation Forest algorithm built directly in repo, trained with synthetic mesh transactions) combined with transparent weighted heuristic rules (0–100 scale).
- **New Endpoints**:
  - `GET /api/flagged`: Lists flagged transactions awaiting human review.
  - `POST /api/flagged/:id/review`: Accepts `{ decision: "approve" | "reject" }`. Approving routes the payment through the standard idempotent settlement pipeline.

### Step 6: Simulator & React Dashboard
- Standalone Node.js simulator in `/mern/simulator` + simulator service in `/mern/server`.
- Pushes live mesh gossip events, packet transfers, and settlement updates via WebSocket (`ws`) or Server-Sent Events (SSE).
- Modern React + Vite dashboard in `/mern/client` featuring:
  - Interactive visual mesh network topology.
  - Live activity ledger & status feed.
  - Risk Queue management modal for reviewing flagged payments.
  - Quick-trigger demo scenarios (Normal Payment, Concurrent Bridges, Tampered Packet, Replay Packet, Velocity Burst).

---

## 6. Questions & Items for User Confirmation

Before beginning code implementation in Step 2, please confirm the following design choices:

1. **MongoDB Environment**:
   - For automated tests and zero-setup local execution (when an external MongoDB instance is not running), should we include `mongodb-memory-server` so that `npm test` and `npm run dev` work instantly out of the box without requiring the user to install/configure MongoDB manually?
2. **Ingest Outcome on Flagged Payments**:
   - In the Java implementation, outcomes were `"SETTLED"`, `"DUPLICATE_DROPPED"`, or `"INVALID"`. When a payment is held by the AI risk engine, should the API return `"FLAGGED"` or `"PENDING_REVIEW"`?
3. **Module System**:
   - We propose using modern ES Modules (`"type": "module"` with `import`/`export`) throughout `/mern/server` and `/mern/simulator` for clean syntax, consistency with React/Vite, and native Node 24 support. Please confirm if ESM is preferred over CommonJS.
4. **Relay Node Identification**:
   - In the Java demo, the request header passed was `X-Bridge-Node-Id` and `X-Hop-Count`. For the relay reputation feature in Step 5, should we support an optional `X-Relay-Nodes` header (comma-separated node IDs) or simulate the intermediate path in the mesh simulator?
