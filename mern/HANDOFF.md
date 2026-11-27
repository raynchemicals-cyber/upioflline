# Project Handoff: UPI Offline Mesh Payments

## Current State
- **Branch:** `feature/step2-trust-management`
- **Stack:** Node.js, Express, React 19 (Vite), MongoDB/Mongoose, In-Memory BLE Mesh Simulator.
- **Test Status:** 53 unit tests passing in `mern/server/tests` (`metrics.test.js`, `trust.test.js`, `crypto.test.js`, `routing.test.js`).
- **Build Status:** React Vite frontend builds cleanly with zero errors (`npm run build` in `mern/client`).

---

## Completed Tasks

1. **Exp F (Oracle-Free Blame Attribution):**
   - Credited `forward_ok` (+3) only when packets verify end-to-end (ciphertext matches).
   - On failed verification, penalised all intermediate relays on the path uniformly with `path_contaminated` (−5).
   - 200 packets × 5 runs. **Negative result:** uniform blame misclassifies honest relays that share a path with the tamperer. It does not isolate a contaminated branch.
   - **Seed bug (fixed):** `buildTopology` ignored the rng, so seeds 5/1005/2005/3005/4005 produced one graph and identical scores. Exp F now draws skip-2/skip-3 edges from the run rng (A–E still use the fixed cross-links). Rerun: 5 distinct graphs (15/16/16/13/18 edges); malicious score 0.0 in all 5; min honest 0 / 2.401 / 0.321 / 0 / 0.321; separated in 3/5 only because a few honest scores sit just above 0.
   - **Why node-6/7/8 stay at 80.00 (seed 5):** the only bridge is node-4. Flood will not revisit a node, TTL is 5, and trust updates only nodes on a bridge-delivery path. node-6 is at least 4 hops from src and cannot still reach node-4, so node-6/7/8 never receive `forward_ok` or `path_contaminated`. Seed-5 paths all end `…>node-4` and are: src>node-0>node-1>node-3>node-4, src>node-0>node-2>node-3>node-4, src>node-0>node-2>node-5>node-4, src>node-0>node-1>node-2>node-3>node-4, src>node-0>node-1>node-2>node-5>node-4, src>node-0>node-2>node-1>node-3>node-4. Every one of those paths includes the tamperer (node-0), so every used honest relay falls to 0.

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
- Exp G: signed hop verification (penalise only the previous hop). False-positive/false-negative columns on A/F/G. Rewrite Exp F as a negative result. Regenerate RESULTS.md. Dashboard check. Single trust source.
- Run `concurrency.and.pipeline.test.js` against a live local MongoDB instance.

## Task log
- **Task 1 (done):** Diagnosed Exp F. Topology now varies by seed. Run: `cd mern/simulator && node src/experiments.js --only=f`. Numbers are in `simulator/results/exp_f.json`.
