# UPI Offline Mesh Payments (MERN + Bluetooth Mesh Simulator)

Offline-first store-and-forward peer-to-peer digital payments via simulated Bluetooth Low Energy (BLE) mesh network with RSA+AES-GCM encryption, dynamic Exponential Moving Average (EMA) trust-aware routing, idempotent settlement, and AI risk scoring.

---

## Quick Start & Run Instructions

### 1. Prerequisites
- **Node.js** v20+ (v24 recommended)
- **MongoDB** (optional for simulator and isolated unit tests; required for full end-to-end server persistence)

### 2. Run Experiments & Benchmarks (Exp A through Exp F)
```bash
cd mern/simulator
npm install
npm run experiments
```
Output files are written as both CSV and JSON to `/results` and `mern/simulator/results`:
- `exp_a.csv`, `exp_a.json`: Trust evolution and fraud flagging
- `exp_b.csv`, `exp_b.json`: Flooding vs. Trust-Aware routing comparison
- `exp_c.csv`, `exp_c.json`: Drop rate sweep (0%, 10%, 30%, 50%)
- `exp_d.csv`, `exp_d.json`: Node density scaling sweep (5, 10, 20, 30 relays)
- `exp_e.csv`, `exp_e.json`: Cryptographic tamper rejection, 24h replay rejection, SETNX deduplication
- `exp_f.csv`, `exp_f.json`: Oracle-free blame attribution under uniform path penalty
- `summary.json`: Experiment execution manifest

To regenerate `RESULTS.md` from actual benchmark results at any time:
```bash
node scripts/generateResultsDoc.js
```

### 3. Run Unit & Regression Tests
```bash
cd mern/server
npm install
npm test
```
Runs unit tests for crypto validation, trust dynamics, trust-aware routing, and metrics services without requiring a running database.

### 4. Run the Full Dashboard & Backend
```bash
# Terminal 1: Express Backend (port 8080)
cd mern/server
npm run dev

# Terminal 2: React Vite Dashboard (port 3000)
cd mern/client
npm install
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser. The dashboard displays:
- **Live Bluetooth Mesh Topology:** Interactive canvas showing packet hops and relay nodes.
- **Relay Node Trust Registry:** Dynamic EMA trust scores with `MALICIOUS`, `UNRELIABLE`, and `HONEST` badges.
- **Live Traffic & Security Stream:** Real-time Server-Sent Events (SSE) chart tracking sent, delivered, dropped, tampered, and duplicate packets.
- **Empirical Benchmark Results:** Visual comparison tabs reading `/results` for density scaling, routing overhead, and drop rate resilience.

---

## Architectural Clarity: Dual Trust Score Model

1. **Mesh Simulator Routing Trust (`TrustManager`):** In-memory EMA ($α=0.15, \delta_{tamper}=-35, \delta_{drop}=-8, \delta_{ok}=+3$) operating locally on peer devices to prune rogue relays and select forwarding hops with $\epsilon$-greedy exploration ($\epsilon=0.10$).
2. **Backend Server Risk Scorer (`RelayNode.trustScore`):** Persisted in MongoDB by `BridgeIngestionService` and analyzed by the Isolation Forest model to evaluate transaction risk upon bridge upload.

These two stores are decoupled by design: mobile phones in an offline mesh cannot query a centralized database for peer reputation without network access.

---

## "What's NOT Real" (Production Simplifications)

| Feature in Demo | Why it is a Simulation Shortcut | Real-World Production Equivalent |
|---|---|---|
| **Simulated Bluetooth Mesh** | Discrete-event virtual nodes in memory | Android Nearby Connections / BLE GATT characteristics with background services |
| **Drop Detection** | Simulator ground truth via `shouldDrop()` | Per-hop Link Layer Acknowledgments (ACK) with retransmission timeouts |
| **Tamper Blame Attribution** | Receiver sees altered AES-GCM ciphertext | Per-hop cryptographic signatures; otherwise, blame is uniform along the path (see Exp F) |
| **Reimplemented Exp E Checks** | Mock re-entry cache in simulator | Live `BridgeIngestionService` freshness window check with synchronized hardware clocks |
| **Demo Key Management** | Ephemeral RSA keypairs generated on server start | Hardware Security Modules (HSM) / Android Keystore StrongBox backed keys |
| **Settlement Rails** | Virtual MongoDB double-entry balance ledger | NPCI UPI Switch and Core Banking System (CBS) ISO 8583 / 20022 settlement APIs |
| **Exp G Accusation Integrity** | Assumes accusations cannot be forged; links are authenticated (relay cannot spoof `from` field) | Mutual authentication on each BLE link; signed accusation messages with their own key pairs |
| **Exp G Silent Drops** | A silently-dropping relay evades signature checks; drop detection uses simulator ground truth (`behaviourProfile`) | Hop-by-hop ACK + receipt timeout; drop blame would require a separate ACK-signing layer |
| **Exp G Key Distribution** | Key registry is a global in-process singleton; revocation not modelled | PKI with certificate revocation lists (CRL) or OCSP; device-local key attestation via TEE |
| **Blame / Drop Attribution (Exp A–G)** | Silent drops and path contamination blame use simulator ground truth (`behaviourProfile`, `shouldDrop()`, `shouldTamper()`) | Only signature-based blame (Exp G) is achievable without ground truth in a real deployment |
