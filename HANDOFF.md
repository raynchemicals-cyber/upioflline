# Project Handoff: UPI Offline Mesh Payments

## Current State
- **Branch:** `feature/step2-trust-management`
- **Stack:** Node.js, Express, React 19 (Vite), MongoDB/Mongoose, In-Memory BLE Mesh Simulator.
- **Test Status:** 53 unit tests passing in `mern/server/tests` (`metrics.test.js`, `trust.test.js`, `crypto.test.js`, `routing.test.js`). `concurrency.and.pipeline.test.js` requires a live MongoDB — pre-existing, not regressions.
- **Build Status:** React Vite frontend builds cleanly with zero errors (`npm run build` in `mern/client`).

---

## Completed Tasks

1. **Exp F (Oracle-Free Blame Attribution) Fixed:**
   - Credited `forward_ok` (+3) only when packets verify end-to-end (ciphertext matches).
   - On failed verification, penalised all intermediate relays on the path uniformly with `path_contaminated` (−5).
   - Increased scale to 200 packets per run across 5 distinct seeds.
   - Printed full per-node trust table.
   - **Honest Scientific Finding:** Downstream honest relays situated directly between the attacker and the bridge absorb equal penalties, decaying to 0.00 alongside the attacker. Thus, individual separation from downstream path neighbors does not occur under uniform penalty without per-hop cryptographic signatures. However, the corrupted branch as a whole is quarantined by trust-aware routing.

2. **Metrics & Telemetry Service:**
   - Implemented `MetricsCollector` (simulator) and `MetricsService` (server).
   - Endpoints: `GET /api/metrics` (snapshot) and `GET /api/metrics/stream` (SSE live stream).
   - Tracks sent, delivered, dropped, duplicates, rejected-tampered, rejected-stale, hop statistics (mean/max/min), delivery delay, and transmission overhead.
   - Comprehensive test coverage in `mern/server/tests/metrics.test.js`.

3. **Empirical Benchmarks (Exp A through Exp G):**
   - Seeded runs (Mulberry32 PRNG + discrete-event simulated clock).
   - Exported in both JSON and CSV to `/results`, `mern/results`, and `mern/simulator/results`:
     - Exp A: Trust evolution (1 malicious, 2 unreliable; fraud flagging).
     - Exp B: Flooding vs Trust-Aware routing (delivery rate, overhead, delay).
     - Exp C: Drop rate sweep (0%, 10%, 30%, 50%).
     - Exp D: Relay density sweep (5, 10, 20, 30 relays).
     - Exp E: Cryptographic tamper, 24h replay, and duplicate rejections.
     - Exp F: Oracle-free blame attribution (200 packets, uniform penalty).
     - Exp G: Signed-hop verification (RSA-2048 sig per packet, relay blames only prev hop).

4. **Exp G (Signed-Hop Verification) — Step 2 Task 2:**
   - Variants: Ga (control, 0 malicious), Gb (10 nodes, 1 malicious), Gc (10 nodes, 2 malicious), Gb routing modes (flood vs trust-aware).
   - Each: 200 packets × 5 seeds.
   - **Results (first honest run, no tuning):**
     - Ga: FP=0 across all 5 seeds ✅ (0 honest nodes classified MALICIOUS in control).
     - Gb: FP=0, FN=0 across all 5 seeds — malicious node reaches 0.00, honest nodes stay ≥80.
     - Gc: FP=0 across all seeds. FN=1 in run 3 (malicious node never on delivery path → never penalised → stays at init trust 80.00).
     - Flood vs trust-aware: trust-aware reduces sig-verify overhead by pruning low-trust paths.
   - **Why nodes 6–8 stay at 80.00 (Exp F answer):** These nodes were never on any delivery path; they receive neither rewards nor penalties, so they remain at the EMA initial value (80.00).
   - **No penalties or thresholds were changed.** Only bugs fixed: `let` reassignment of a function parameter in `_applyTrustUpdates` (was `tamperedNodes = []` on a parameter, now uses `tamperedNodesIn` rename).

5. **Seed Test Fixed (Step 2 Task 1):**
   - Replaced the non-asserting "different seeds may produce different results" routing test.
   - New test: builds a 10-node topology with seeded cross-links and asserts seeds 1000 and 2000 produce **different edge fingerprints** (topologies). This directly validates that the seeded PRNG affects graph structure.

6. **Dashboard Views Added:**
   - `TrustScorePanel.jsx`: Per-relay dynamic EMA trust table with `MALICIOUS`, `UNRELIABLE`, and `HONEST` badges.
   - `LiveTrafficChart.jsx`: Real-time SSE live traffic and security streaming monitor.
   - `ExperimentResultsView.jsx`: Interactive comparison tabs loading empirical metrics from `/results`.
   - All existing views (Mesh topology canvas, demo controls, risk queue, accounts, ledger) preserved.

7. **Trust Architecture Boundary:**
   - Documented clear architectural separation: `TrustManager` EMA drives local peer routing on edge devices without server connectivity; `RelayNode.trustScore` in MongoDB feeds backend risk scoring upon bridge ingestion.

8. **Documentation & Automated Results:**
   - Automated generator script (`scripts/generateResultsDoc.js` and `npm run experiments`) generates `RESULTS.md` directly from `/results` JSON.
   - Comprehensive run instructions and "What's not real" disclaimers documented in root `README.md` and `mern/README.md`.
   - **Exp G assumptions added to README "What's not real":** accusations cannot be forged; links are authenticated; silent drops evade sig-checks (ground-truth path separate); key distribution and revocation not modelled; drop blame (A–G) uses simulator ground truth.

---

## How to Run

```bash
# 1. Run experiments & regenerate RESULTS.md:
cd mern/simulator
npm run experiments          # all experiments (A–G)
npm run experiments -- --only=g  # Exp G only (faster)

# 2. Run unit test suite:
cd mern/server
npm test -- --runInBand

# 3. Build & test React dashboard:
cd mern/client
npm run build
```

---

## What's Next
- Run `concurrency.and.pipeline.test.js` against a live local MongoDB instance.
- Provide a `docker-compose.yml` to launch MongoDB, backend, simulator, and dashboard together with one command.
- Consider per-seed delivery-rate variation analysis for Exp G (delivery drops to 0% in some seeds when the malicious node blocks the only path — topology-dependent).

---

## Completed Tasks

1. **Exp F (Oracle-Free Blame Attribution) Fixed:**
   - Credited `forward_ok` (+3) only when packets verify end-to-end (ciphertext matches).
   - On failed verification, penalised all intermediate relays on the path uniformly with `path_contaminated` (−5).
   - Increased scale to 200 packets per run across 5 distinct seeds.
   - Printed full per-node trust table.
   - **Honest Scientific Finding:** Downstream honest relays situated directly between the attacker and the bridge absorb equal penalties, decaying to 0.00 alongside the attacker. Thus, individual separation from downstream path neighbors does not occur under uniform penalty without per-hop cryptographic signatures. However, the corrupted branch as a whole is quarantined by trust-aware routing.

2. **Metrics & Telemetry Service:**
   - Implemented `MetricsCollector` (simulator) and `MetricsService` (server).
   - Endpoints: `GET /api/metrics` (snapshot) and `GET /api/metrics/stream` (SSE live stream).
   - Tracks sent, delivered, dropped, duplicates, rejected-tampered, rejected-stale, hop statistics (mean/max/min), delivery delay, and transmission overhead.
   - Comprehensive test coverage in `mern/server/tests/metrics.test.js`.

3. **Empirical Benchmarks (Exp A through Exp F):**
   - Seeded runs (Mulberry32 PRNG + discrete-event simulated clock).
   - Exported in both JSON and CSV to `/results`, `mern/results`, and `mern/simulator/results`:
     - Exp A: Trust evolution (1 malicious, 2 unreliable; fraud flagging).
     - Exp B: Flooding vs Trust-Aware routing (delivery rate, overhead, delay).
     - Exp C: Drop rate sweep (0%, 10%, 30%, 50%).
     - Exp D: Relay density sweep (5, 10, 20, 30 relays).
     - Exp E: Cryptographic tamper, 24h replay, and duplicate rejections.
     - Exp F: Oracle-free blame attribution (200 packets, uniform penalty).

4. **Dashboard Views Added:**
   - `TrustScorePanel.jsx`: Per-relay dynamic EMA trust table with `MALICIOUS`, `UNRELIABLE`, and `HONEST` badges.
   - `LiveTrafficChart.jsx`: Real-time SSE live traffic and security streaming monitor.
   - `ExperimentResultsView.jsx`: Interactive comparison tabs loading empirical metrics from `/results`.
   - All existing views (Mesh topology canvas, demo controls, risk queue, accounts, ledger) preserved.

5. **Trust Architecture Boundary:**
   - Documented clear architectural separation: `TrustManager` EMA drives local peer routing on edge devices without server connectivity; `RelayNode.trustScore` in MongoDB feeds backend risk scoring upon bridge ingestion.

6. **Documentation & Automated Results:**
   - Automated generator script (`scripts/generateResultsDoc.js` and `npm run experiments`) generates `RESULTS.md` directly from `/results` JSON.
   - Comprehensive run instructions and "What's not real" disclaimers documented in root `README.md` and `mern/README.md`.

---

## How to Run

```bash
# 1. Run experiments & regenerate RESULTS.md:
cd mern/simulator
npm run experiments

# 2. Run unit test suite:
cd mern/server
npm test

# 3. Build & test React dashboard:
cd mern/client
npm run build
```

---

## What's Next
- Run `concurrency.and.pipeline.test.js` against a live local MongoDB instance.
- Provide a `docker-compose.yml` to launch MongoDB, backend, simulator, and dashboard together with one command.

---

## Release
- **2026-11-27:** Merged `feature/step2-trust-management` into `master` (`80e26f1`) and pushed `origin/master`.
- **Remaining:** Run `concurrency.and.pipeline.test.js` outside the sandbox against MongoDB (`mongodb-memory-server` or local `mongod`) and add `docker-compose.yml`.
