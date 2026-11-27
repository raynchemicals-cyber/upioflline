# UPI Offline Mesh — Improvement Plan

> **STEP 1 AUDIT OUTPUT** — read by the project reviewer before any code is written.

---

## 1. How Relays Are Modelled Today

### Server-side (`server/src/models/RelayNode.js`)

The `RelayNode` Mongoose schema stores per-node state in MongoDB:

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `nodeId` | String | — | Unique node identifier |
| `reputation` | Number | 100 | 0–100 score, decays on bad events |
| `totalRelayed` | Number | 0 | Count of all packets forwarded |
| `invalidRelayed` | Number | 0 | Count of tampered/bad packets |

**Missing:** no `trustScore`, no behaviour classification (`HONEST` / `UNRELIABLE` / `MALICIOUS`), no drop/delay counters, no timestamps for decay, no smoothing.

### Simulator-side (`simulator/src/meshNode.js`)

The `MeshNode` class tracks:
- `id`, `label`, `hasInternet`, `isRogue`
- `peers` (Set of peer IDs)
- `packetCache` (Map: packetId → {packet, receivedAt})

**Gap:** `isRogue` is a hard boolean flag — there is no continuous trust score, no configurable behaviour profile (unreliable vs malicious), and no link back to the server-side reputation.

---

## 2. Where Reputation Is Stored and Updated

### Storage
`RelayNode` documents in MongoDB, plus an in-memory lookup during ingestion in `riskScoringService`.

### Update points (server)
- **`riskScoringService.penalizeRelay(nodeId, penalty=20)`** — called by `bridgeIngestionService` on decryption failure. Decrements `reputation` by 20, increments `invalidRelayed`.
- **`riskScoringService.rewardRelay(nodeId, reward=2)`** — called by `bridgeIngestionService` on successful settlement. Increments `reputation` by 2, increments `totalRelayed`.

### Critical gap
Reputation is **read** in `evaluateRisk` (as `minReputation`, used to bump the rule-score) but is **never used to influence routing**. The simulator's flooding loop in `meshNetwork.js` picks every peer unconditionally; it never consults `reputation` or trust score when choosing the next hop.

---

## 3. How the Simulator Forwards Packets (Flooding)

`meshNetwork.js → propagatePacket()` uses **BFS flooding**:

```
queue = [sourceNode]
while queue not empty:
    node = dequeue
    for each peer of node:
        if peer not already in path:
            maybe drop (uniform dropRate)
            if node.isRogue: tamper ciphertext
            enqueue peer
```

**Routing decisions:** none — every reachable peer is always forwarded to.
**No trust weighting:** a rogue node's peers get packets just as readily as honest nodes' peers.
**`meshSimulatorService.js`** (server-side) uses an even simpler gossip: every device broadcasts to every other device each round — full-mesh flooding, no topology awareness at all.

---

## 4. Metrics That Exist Today

### Events emitted by `meshNetwork.js`
| Event Type | Fields |
|------------|--------|
| `PACKET_INJECTED` | nodeId, packetId, ttl |
| `BRIDGE_REACHED` | bridgeId, packetId, hopCount, path |
| `PACKET_DROPPED` | from, to, packetId |
| `PACKET_TAMPERED` | rogueNode, packetId |
| `PACKET_HOP` | from, to, packetId, ttl, hopCount |
| `SCENARIO_START` / `SCENARIO_COMPLETE` | scenario, outcome |

### What is NOT tracked
- Duplicates (same packetId arriving at a node twice)
- Rejected-as-tampered at the ingestion layer (counted but not surfaced as a time-series)
- Rejected-as-stale / replayed
- End-to-end delay (packet creation → settlement)
- Mean / max hop count per run
- Transmission overhead (total transmissions ÷ delivered payments)
- Per-time-window rolling windows
- Experiment results (no harness, no CSV/JSON output)

---

## 5. Files to Change — by Step

### Step 2: Trust Management

| File | Change |
|------|--------|
| `server/src/models/RelayNode.js` | Add `trustScore` (0–100 float), `classification` enum (`HONEST`/`UNRELIABLE`/`MALICIOUS`), `drops`, `delays`, `forwardedOk`, `lastEventAt` |
| `server/src/services/riskScoringService.js` | Replace flat `reputation` with EMA-smoothed `trustScore`; add `updateTrust(nodeId, event, value)` using documented update rule; keep `penalizeRelay`/`rewardRelay` as thin wrappers |
| `simulator/src/meshNode.js` | Add `behaviourProfile` (`honest` / `unreliable` / `malicious`), `trustScore` (local copy, synced from server), drop/delay parameters per profile |
| `simulator/src/meshNetwork.js` | Add `routingMode` config (`flood` / `trust-aware`); in trust-aware mode: sort peers by trust score descending, skip peers below `minTrustThreshold`; keep flood mode as default selectable via env/config |
| `simulator/src/scenarios.js` | Extend `ScenarioRunner` to accept behaviour profiles per node; add helpers for trust-aware vs flood experiment scenarios |

### Step 3: Traffic and Security Metrics

| File | Change |
|------|--------|
| `simulator/src/metricsCollector.js` *(new)* | In-process collector: counters for sent, delivered, dropped, duplicates, tampered-rejected, stale-rejected, hop stats, delay, overhead |
| `server/src/services/metricsService.js` *(new)* | Server-side aggregator; expose rolling windows (per-minute, per-run) |
| `server/src/routes/api.js` | Add `GET /api/metrics` and `GET /api/relay-nodes` |
| `server/src/controllers/apiController.js` | Add `getMetrics`, `listRelayNodes` handlers |

### Step 4: Experiment Harness

| File | Change |
|------|--------|
| `simulator/src/experiments.js` *(new)* | Seeded simulation runner; 5 experiment groups (a–e); outputs to `/results/*.csv` and `/results/*.json` |
| `simulator/package.json` | Add `"experiments": "node src/experiments.js"` script |

### Step 5: Dashboard

| File | Change |
|------|--------|
| `client/src/App.jsx` | Add state for `relayNodes`, `metrics`, `experimentResults`; wire new API calls; add new panel layout rows |
| `client/src/components/TrustScorePanel.jsx` *(new)* | Per-relay trust score table with malicious indicator and colour coding |
| `client/src/components/TrafficChart.jsx` *(new)* | Live rolling chart: packets sent / delivered / dropped / duplicates over time |
| `client/src/components/ExperimentResultsView.jsx` *(new)* | Renders `/results` data as comparison tables and bar charts |

### Step 6: Tests and Docs

| File | Change |
|------|--------|
| `server/tests/trust.test.js` *(new)* | Jest tests: trust update rule, EMA smoothing, classification thresholds |
| `server/tests/metrics.test.js` *(new)* | Jest tests: counter correctness, delivery rate, overhead calculation |
| `server/tests/routing.test.js` *(new)* | Jest tests: trust-aware route selection avoids low-trust hops |
| `mern/README.md` | Add: "Running experiments", "What's not real" disclaimer |
| `mern/RESULTS.md` *(new, generated)* | Filled in after `npm run experiments` completes |

---

## 6. Trust Score Update Rule (Documented)

The trust score `T` for each relay node is maintained as an **Exponential Moving Average (EMA)** to prevent single events from dominating:

```
α = 0.15                          # smoothing factor (lower = slower to change)

on correct forward / delivered:
  sample = min(100, T + 5)
  T_new = α * sample + (1 - α) * T

on drop (random):
  sample = max(0, T - 10)
  T_new = α * sample + (1 - α) * T

on slow forward (> 2× median delay):
  sample = max(0, T - 5)
  T_new = α * sample + (1 - α) * T

on tampered / decryption failure:
  sample = max(0, T - 25)
  T_new = α * sample + (1 - α) * T    # hard penalty, still smoothed

classification thresholds:
  T >= 70  →  HONEST
  40 <= T < 70  →  UNRELIABLE
  T < 40  →  MALICIOUS
```

New nodes start at `T = 80` (slight optimism, not full trust).

---

## 7. Trust-Aware Routing Logic

```
function choosePeers(currentNode, packet, allPeers, mode):
  if mode == 'flood':
    return allPeers  # unchanged behaviour

  if mode == 'trust-aware':
    ranked = sort(allPeers, by=trustScore DESC)
    # Hard exclude nodes below threshold (default 30)
    eligible = filter(ranked, trustScore >= MIN_TRUST_THRESHOLD)
    # Always keep at least 1 path (highest-scored) even if below threshold
    if eligible is empty:
      eligible = [ranked[0]]
    # Soft-prefer top-k peers (reduce overhead vs flooding)
    return eligible[:MAX_NEXT_HOPS]  # default MAX_NEXT_HOPS = 3
```

Routing mode is selected via `ROUTING_MODE` env var (`flood` | `trust-aware`), defaulting to `flood` to preserve existing behaviour.

---

## 8. Behaviour Profiles for Simulator Nodes

| Profile | Drop rate | Delay multiplier | Tamper rate |
|---------|-----------|-----------------|-------------|
| `honest` | 0% | 1× | 0% |
| `unreliable` | configurable (default 30%) | 2× | 0% |
| `malicious` | 0% | 1× | 100% of packets |

Profiles are assigned per node in experiment config; `isRogue` boolean is kept for backward compat and maps to `malicious`.

---

## 9. Experiment Matrix

| ID | Name | Variable | Runs |
|----|------|----------|------|
| a | Trust evolution | 1 malicious / 2 unreliable mixed in honest network | 5 |
| b | Flood vs trust-aware | Routing mode, same topology | 5 |
| c | Drop rate sweep | 0 / 10 / 30 / 50 % | 5 |
| d | Density sweep | 5 / 10 / 20 / 30 nodes | 5 |
| e | Security rejections | Tampered / duplicate / stale packets | 5 |

Each run uses a seeded PRNG (`seed = runIndex * 1000 + expIndex`) so results are **deterministic and reproducible**.

---

## 10. What Will NOT Be Added (Per Instructions)

- K-Means clustering of relay behaviour
- Multi-Armed Bandit adaptive routing
- These may be revisited after baseline results are reviewed

---

## Approval Checkpoint

> **Please review this plan and reply "approved" or request changes before any code is written.**
