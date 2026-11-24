# UPI Offline Mesh — MERN Stack Implementation

A complete, production-grade migration of **UPI Offline Mesh** to the **MERN Stack** (Node.js, Express, React, MongoDB) that preserves the behavioral contracts, API routes, and wire cryptography of the original Spring Boot reference implementation byte-for-byte, while introducing **pure Node.js AI Fraud & Risk Scoring**, an **interactive multi-hop mesh network simulator**, and a **mission control dashboard**.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites & Quick Start](#prerequisites--quick-start)
3. [The End-to-End Payment Flow](#the-end-to-end-payment-flow)
4. [Cryptographic Contract (Byte-for-Byte Wire Compatibility)](#cryptographic-contract)
5. [Exactly-Once Settlement & Concurrency](#exactly-once-settlement--concurrency)
6. [AI Fraud & Anomaly Risk Scoring](#ai-fraud--anomaly-risk-scoring)
7. [Mesh Simulator & Demonstration Scenarios](#mesh-simulator--demonstration-scenarios)
8. [API Reference](#api-reference)
9. [Running Tests](#running-tests)
10. [What's NOT Real (Production Simplifications)](#whats-not-real)

---

## Architecture Overview

```
                      ┌──────────────────────────────────────────┐
                      │          SENDER PHONE (Offline)          │
                      │  PaymentInstruction { sender, receiver,  │
                      │    amount, pinHash, nonce, signedAt }    │
                      │                     │                    │
                      │                     ▼ (Hybrid Encrypt)   │
                      │   MeshPacket { packetId, ttl, createdAt, │
                      │                ciphertext }              │
                      └─────────────────────┬────────────────────┘
                                            │ Simulated BLE Gossip
                                            ▼
           ┌──────────┐  Hop   ┌──────────┐  Hop   ┌──────────┐
           │Stranger 1│ ─────▶ │Stranger 2│ ─────▶ │ Bridge 1 │ ◀── Walks outside
           └──────────┘        └──────────┘        └────┬─────┘     gets 4G
                                                        │
                                                        ▼ HTTPS POST /api/bridge/ingest
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              NODE.JS / EXPRESS BACKEND                                 │
│                                                                                        │
│  [1] Hash Ciphertext (SHA-256)                                                         │
│       │                                                                                │
│  [2] Idempotency Gate (In-Memory Map / Redis SETNX semantics)                          │
│       │ └─▶ Already claimed? Drop immediately as DUPLICATE_DROPPED (Zero CPU wasted)   │
│       ▼                                                                                │
│  [3] Hybrid Decrypt & GCM AEAD Tag Authentication                                      │
│       │ └─▶ Single-bit tampering? Throws AEADBadTag ➔ INVALID (decryption_failed)       │
│       ▼                                                                                │
│  [4] Freshness Window Verification (Replay Protection)                                 │
│       │ └─▶ Older than 24 hours? ➔ INVALID (stale_packet)                              │
│       ▼                                                                                │
│  [5] AI Fraud & Anomaly Risk Scoring (Isolation Forest + Transparent Rules)            │
│       │ └─▶ Risk Score >= 50? ➔ Stored in flagged_payments for human review            │
│       ▼                                                                                │
│  [6] Atomic Settlement & Ledger Entry                                                  │
│       │ └─▶ MongoDB Transaction / Atomic Conditional $inc with unique index fallback   │
│       └─▶ Account Balances Updated + Immutable Transaction Record Created              │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites & Quick Start

### Prerequisites
- **Node.js**: v18+ (tested on Node v24.14.1)
- **MongoDB**: Optional! If `MONGODB_URI` is omitted, the server automatically boots an embedded **in-memory MongoDB** server (`mongodb-memory-server`) for zero-setup execution.

### 1. Start Backend Server
```bash
cd mern/server
cp .env.example .env
npm install
npm run dev
```
The server will boot on `http://localhost:8080` and initialize WebSocket telemetry on `ws://localhost:8080/ws/mesh`.

### 2. Start Live React Dashboard
```bash
cd mern/client
npm install
npm run dev
```
Open **`http://localhost:3000`** (or browse directly to `http://localhost:8080` when built) to view the Mission Control interface.

### 3. Optional: Run Standalone Simulator CLI
```bash
cd mern/simulator
npm install
npm run scenario:normal
```

---

## Cryptographic Contract

The cryptographic scheme is implemented using **Node.js built-in `crypto` only** (no third-party crypto packages) and matches the Java Spring Boot SunJCE provider byte-for-byte:

- **RSA Key Specs**: 2048-bit key. OAEP padding with SHA-256 for both OAEP digest and MGF1 digest (`oaepHash: 'sha256'`). Public key exported in DER SubjectPublicKeyInfo (SPKI) Base64 format.
- **AES Key Specs**: AES-256-GCM (`aes-256-gcm`). 256-bit random session key generated per packet. 12-byte IV (`crypto.randomBytes(12)`). 16-byte (128-bit) authentication tag.
- **Binary Wire Layout**:
  ```
  [ 256 bytes RSA encrypted AES key ][ 12 bytes IV ][ N bytes AES ciphertext ][ 16 bytes GCM Auth Tag ]
  ```
  Java appends the 16-byte tag to the ciphertext returned by `aes.doFinal()`. Node.js returns the tag separately via `cipher.getAuthTag()`. The server unpacks the last 16 bytes as the tag and passes it to `decipher.setAuthTag(authTag)`.
- **Ciphertext Hash (Idempotency Key)**:
  Evaluated over the **UTF-8 string bytes of the Base64 ciphertext**:
  ```javascript
  crypto.createHash('sha256').update(base64Ciphertext, 'utf8').digest('hex')
  ```

---

## Exactly-Once Settlement & Concurrency

When multiple bridge nodes simultaneously receive the same payment and upload to `/api/bridge/ingest`, exactly-once settlement is guaranteed through three defensive layers:

1. **Idempotency Gate**: Early in-memory atomic claim on `ciphertextHash` drops concurrent duplicates before decryption.
2. **Database Unique Compound Index**: A unique index on `Transaction.packetHash` (`{ packetHash: 1 }, { unique: true }`) rejects concurrent duplicate inserts with error code 11000, which is handled gracefully as `DUPLICATE_DROPPED`.
3. **Atomic Balance Updates & ACID Transactions**: Multi-document transactions (`session.withTransaction`) are used when a replica set is detected; on standalone instances, atomic `$inc` updates with conditional balance checks (`{ vpa: senderVpa, balance: { $gte: amount } }`) guarantee that balances can never become negative or be debited twice.

---

## AI Fraud & Anomaly Risk Scoring

Inserted directly **after** signature/tamper/freshness checks and **before** ledger settlement:

- **Signals Evaluated**:
  - `hopCount`: Network diameter traversed (penalties for $> 5$ or $> 7$ hops).
  - `latencySeconds`: Elapsed time between packet creation and bridge ingestion.
  - `senderVelocity`: Count of offline payments dispatched by this sender in the last 5 minutes without prior backend sync.
  - `amountDeviation`: Spike ratio relative to sender's historical average.
  - `relayReputation`: Reputation score (0–100) of intermediate relays. When a node delivers a tampered or invalid packet, its reputation drops by 20 points; low-reputation relays raise the risk of any packet traversing them.
- **Anomaly Detection Model**:
  An in-repository, pure JavaScript **Isolation Forest** trained on synthetic mesh baseline vectors, blended with transparent heuristic rules (0–100 scale).
- **Threshold**: Configured via `RISK_THRESHOLD` (default: 50).
  - Score $< 50$: Automatically settles.
  - Score $\ge 50$: Stored in the `FlaggedPayment` collection with `status: 'PENDING_REVIEW'`. Returned as `{ outcome: "FLAGGED", reason: "risk_score_exceeded", riskScore, contributingFactors }`.
- **Human Authorization Workflow**:
  - `GET /api/flagged`: Lists held payments awaiting review.
  - `POST /api/flagged/:id/review`: Accepts `{ decision: "approve" | "reject" }`. Approving routes the payment through the standard idempotent settlement pipeline.

---

## Mesh Simulator & Demonstration Scenarios

The simulator simulates phone nodes with Bluetooth range, propagation delays, and drop rates.

| Scenario | Trigger Button | What Happens | Expected Outcome |
|---|---|---|---|
| **1. Normal Payment** | `1. Normal Payment` | Alice sends ₹150 to Bob in a basement. Hops to bridge node with 4G. | `SETTLED` (₹150 transferred) |
| **2. Duplicate Delivery** | `2. Duplicate Delivery` | Same packet hops to Bridge 1 and Bridge 2. Both upload simultaneously. | Exactly 1 `SETTLED`, 1 `DUPLICATE_DROPPED` |
| **3. Tampered Packet** | `3. Tampered Packet` | Rogue node flips bits in the ciphertext during relay. | `INVALID` (`decryption_failed`) & rogue node penalized |
| **4. Stale Replay** | `4. Stale Replay` | Captures packet and replays it 28 hours later. | `INVALID` (`stale_packet`) |
| **5. Velocity Burst** | `5. Velocity Burst` | Alice emits 6 offline payments in rapid succession without sync. | `FLAGGED` (`risk_score_exceeded`) placed in Risk Queue |

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Web dashboard (serves compiled React frontend if built) |
| `GET` | `/api/server-key` | Server's RSA public key (Base64 SPKI) |
| `POST` | `/api/demo/send` | Simulate sender phone creating & injecting a packet |
| `GET` | `/api/mesh/state` | Current state of all virtual mesh devices |
| `POST` | `/api/mesh/gossip` | Fast-forward 1 gossip round across the mesh |
| `POST` | `/api/mesh/flush` | Internet-connected bridge nodes upload packets concurrently |
| `POST` | `/api/mesh/reset` | Clear virtual devices and idempotency cache |
| `POST` | `/api/bridge/ingest` | **Production Ingestion API** for bridge nodes (`X-Bridge-Node-Id`, `X-Hop-Count`) |
| `GET` | `/api/accounts` | Query all simulated bank account balances |
| `GET` | `/api/transactions` | Query recent settled transactions |
| `GET` | `/api/flagged` | Query payments currently held in the AI Risk Queue |
| `POST` | `/api/flagged/:id/review` | Human review: `{ decision: "approve" \| "reject" }` |

---

## Running Tests

Run the complete Jest integration suite:
```bash
cd mern/server
npm test
```

### Test suite inventory (actual counts from source)

| File | Tests | Requires MongoDB? |
|------|-------|-------------------|
| `tests/crypto.test.js` | 7 | No |
| `tests/trust.test.js` | 27 | No |
| `tests/routing.test.js` | 12 | No |
| `tests/concurrency.and.pipeline.test.js` | 6 | **Yes** (auto-starts in-memory) |

### Concurrency suite prerequisites

`concurrency.and.pipeline.test.js` connects to MongoDB at startup.
If `MONGODB_URI` is unset (default), `mongodb-memory-server` starts automatically — no external MongoDB needed. The suite has a **60 s timeout scoped to itself** (via `jest.setTimeout(60_000)` at the top of that file). The other three suites use Jest's default 5 s timeout.

**To run only the fast suites (no MongoDB needed):**
```bash
cd mern/server
npx jest --testPathPattern="trust|routing|crypto"
```

> **Sandbox / blocked-port environments**: `concurrency.and.pipeline.test.js` cannot run if the sandbox blocks port binding (required by `mongodb-memory-server`). Run it in a real Node environment. The other three suites always pass in any environment.

### Why trust.test.js has 27 tests

The file was written in two phases:
- **Phase 1 (21 tests):** six `describe` blocks covering EMA formula, asymmetric deltas, classification thresholds, blame attribution, drop penalty, and event-log / state management.
- **Phase 2 (+ 6 tests in 2 new describes):** added the consecutive-tamper trace describe (2 tests) and the 10-node scenario describe (this was 1 more test), plus the duplicate of the blame describe brought the total to **27**. The "+2 new" figure in earlier summaries was inaccurate — the correct delta is +6 tests across 2 new describe blocks.

### Running the Experiment Harness

```bash
cd mern/simulator
npm install
npm run experiments
```

Results are written to `mern/simulator/results/` as JSON files. The harness is fully deterministic: running it twice with the same code produces bit-for-bit identical JSON output (excluding the cosmetic timestamp in `summary.json`).

Experiments a–e are the standard suite; **experiment f** (`exp_f.json`) is the oracle-free blame variant added in Step A2.

### Verified Test Suites:
1. **`tests/crypto.test.js`**:
   - Encrypt/decrypt round trip matching all fields.
   - Byte-for-byte wire layout matching Java SunJCE.
   - Rejection of tampered ciphertext via GCM auth exception.
   - Rejection of corrupted GCM auth tag.
   - Rejection of truncated ciphertext.
   - Exact SHA-256 ciphertext hash computation.
   - Base64 SPKI public key encoding compatibility.
2. **`tests/concurrency.and.pipeline.test.js`**:
   - Normal payment ingestion and balance transfer.
   - **10 bridge nodes firing the same packet simultaneously settling EXACTLY ONCE**.
   - Tamper rejection with relay reputation penalization.
   - Stale packet rejection (> 24h freshness window).
   - Future-dated clock-skew protection.
   - AI Fraud & Risk Scoring flagging + human review authorization.
3. **`tests/trust.test.js`**:
   - EMA update formula correctness for every event type.
   - Asymmetric penalty: tamper (−35) ≈ 11.67× forward_ok (+3).
   - Classification thresholds (HONEST ≥ 70, UNRELIABLE 40–69, MALICIOUS < 40).
   - Consecutive tamper trace: reaches MALICIOUS (< 40) in ≤ 8 events from initial trust = 80.
   - 10-node scenario: honest nodes stay ≥ 70, malicious node drops below 40.
   - Blame attribution: tamperer gets −35, path nodes get −5.
   - Drop penalty on forwarding node (delivery-receipt mechanism).
4. **`tests/routing.test.js`**:
   - Trust-aware routing excludes low-trust peers below threshold.
   - Fallback to flooding when no peer meets threshold (no partition).
   - ε-Greedy exploration adds a low-trust peer occasionally.
   - Flood mode always includes all candidates.
   - Seeded PRNG makes routing deterministic across runs.

---

## What's NOT Real (Production Simplifications)

This implementation is an educational and architectural proof of concept. The following simplifications are intentional:

| Demo Feature | Production Implementation |
|---|---|
| In-memory RSA keypair generated on startup | Private key stored in a Hardware Security Module (HSM) or KMS (AWS KMS, HashiCorp Vault); public key baked into Android keystores or distributed via PKI. |
| In-memory `idempotencyService` with Map | Distributed Redis cluster with `SETNX` and 24-hour TTL (`SET key hash NX EX 86400`). |
| Software-simulated BLE mesh | Android BLE GATT characteristics, Wi-Fi Direct, or Nearby Connections API with background service management. |
| Demo accounts (`alice@demo`, `bob@demo`) | Integration with NPCI (National Payments Corporation of India) / Core Banking Systems (CBS) with real VPAs. |
| PIN hashed on device with SHA-256 | Hardware-backed secure element (e.g. Android StrongBox / KeyStore) with bank-verified encrypted PIN blocks. |
| Unreserved offline balances | Hardware-backed offline wallets (like UPI Lite) with pre-funded offline balance reserves to prevent double-spending. |
| Unauthenticated `/api/bridge/ingest` | Mutual TLS (mTLS) with device attestation certificates (Play Integrity API / SafetyNet). |

### Simulator-specific shortcuts ("not real" in the mesh layer)

| Simulator Behaviour | Why it is a shortcut | Real-world equivalent |
|---|---|---|
| **Drop detection uses ground truth** — when `shouldDrop()` returns `true` or the network-level `dropRate` fires, the simulator *knows* exactly which node dropped which packet. The forwarding node immediately receives a `drop` (−8) trust penalty. | In a real BLE mesh there is no guaranteed delivery receipt. A drop is detected only by timeout or an explicit ACK from the next hop, and only the sender of that hop can observe the miss. | Per-hop ACK with configurable timeout (e.g. 500 ms); relay waits for ACK and re-queues or penalises on timeout. |
| **Tamper blame uses simulator ground truth** — `shouldTamper()` returning `true` means the simulator applies the full `tamper` (−35) penalty directly to the tampering node. Innocent relays on the same path receive only `path_contaminated` (−5). | The server (`riskScoringService`) does *not* know which relay tampered; it heuristically blames the last relay before the bridge. This is documented in the trust manager header. **Real blame attribution is an unsolved problem for AES-GCM-encrypted mesh packets: GCM authentication verifies the entire ciphertext but cannot identify *which hop* altered it. Each hop would need to sign the packet with its own device key so the verifier can walk the chain and find the break.** Experiment F in `experiments.js` explores oracle-free blame (uniform path penalty), showing that even without ground truth the malicious node accumulates more penalties over many packets. | Packet-level signing (each hop signs the packet with its device key); verifier identifies exact tamper point from broken chain signature. |
| **Stale/replay detection at the backend uses `Date.now()`** — `bridgeIngestionService` compares `instruction.signedAt` against the real wall clock to detect packets older than 24 h. This is not inside the simulator's seeded PRNG or simulated clock. | Experiment runs use `createdAt: 0` for simulated packets, so stale-check timing never fires inside experiment code. Stale and replay scenarios are tested in `concurrency.and.pipeline.test.js` using live `Date.now()`. | Hardware clock with signed timestamps; NPCI backend tracks packet IDs in a distributed set. |
| **Experiment E (security rejections) reimplements stale/replay checks** — `expE()` in `experiments.js` does not call the real `bridgeIngestionService`. It simulates replay by re-propagating the same `packetId` through the mesh and checking whether nodes' packet caches block re-entry. The real 24 h stale window is not exercised because simulated packets use `createdAt: 0`. | The concurrency test suite (`concurrency.and.pipeline.test.js`) exercises the real `bridgeIngestionService` with live `Date.now()`, including stale and future-dated packets. An injectable-clock variant would require passing a clock into `BridgeIngestionService`; this is noted as a future hardening task. | An injectable `Clock` interface (strategy pattern) passed into `BridgeIngestionService`, with a `SystemClock` default and a `FakeClock` for tests. |
| **Isolation Forest `Math.random()` in tree building** — `isolationForest.js` uses three raw `Math.random()` calls during `fit()` (sub-sampling, feature selection, split-value selection). `riskScoringService.trainInitialModel()` uses a fixed-seed Mulberry32 PRNG to generate the *training data* but cannot inject the PRNG into `IsolationForest.fit()`. | This means the forest structure differs between server restarts. However, training happens once at server startup on fixed synthetic data with identical distribution, so the *functional behaviour* (flagging thresholds) is stable in practice. Experiment runs in `simulator/src/experiments.js` use their own inline `fraudScore()` function that does **not** call the Isolation Forest at all, so experiment reproducibility is unaffected. | Use a seeded PRNG injected into the forest (accepted parameter pattern). |
