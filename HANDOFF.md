# Project Handoff: UPI Offline Mesh Payments

## Current State
- **Branch:** `feature/step2-trust-management`
- **Stack:** Node.js, Express, React 19 (Vite), MongoDB/Mongoose, In-Memory BLE Mesh Simulator.
- **Test Status:** 53 unit tests passing in `mern/server/tests` (`metrics.test.js`, `trust.test.js`, `crypto.test.js`, `routing.test.js`).
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
