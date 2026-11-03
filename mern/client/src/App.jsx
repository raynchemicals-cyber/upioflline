import React, { useState, useEffect, useRef } from 'react';
import confetti from 'canvas-confetti';
import { Radio, RefreshCw, Zap } from 'lucide-react';
import { MeshGraphCanvas } from './components/MeshGraphCanvas.jsx';
import { SettlementFeed } from './components/SettlementFeed.jsx';
import { RiskQueuePanel } from './components/RiskQueuePanel.jsx';
import { DemoControls } from './components/DemoControls.jsx';
import { AccountBalances } from './components/AccountBalances.jsx';
import { ActivityLog } from './components/ActivityLog.jsx';

export default function App() {
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [flagged, setFlagged] = useState([]);
  const [devices, setDevices] = useState([]);
  const [idempotencyCacheSize, setIdempotencyCacheSize] = useState(0);
  const [logs, setLogs] = useState([]);
  const [activeHop, setActiveHop] = useState(null);
  const [isOperating, setIsOperating] = useState(false);
  const [isReviewing, setIsReviewing] = useState(false);
  const wsRef = useRef(null);

  const addLog = (message) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [{ time, message }, ...prev.slice(0, 50)]);
  };

  const refreshData = async () => {
    try {
      const [accs, txs, flg, mesh] = await Promise.all([
        fetch('/api/accounts').then((r) => r.json()).catch(() => []),
        fetch('/api/transactions').then((r) => r.json()).catch(() => []),
        fetch('/api/flagged').then((r) => r.json()).catch(() => []),
        fetch('/api/mesh/state').then((r) => r.json()).catch(() => ({ devices: [], idempotencyCacheSize: 0 })),
      ]);

      if (Array.isArray(accs)) setAccounts(accs);
      if (Array.isArray(txs)) setTransactions(txs);
      if (Array.isArray(flg)) setFlagged(flg);
      if (mesh.devices) {
        setDevices(mesh.devices);
        setIdempotencyCacheSize(mesh.idempotencyCacheSize || 0);
      }
    } catch (err) {
      console.error('Error refreshing dashboard data:', err);
    }
  };

  useEffect(() => {
    refreshData();
    const interval = setInterval(refreshData, 3000);

    // WebSocket connection for real-time events
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:8080/ws/mesh`;
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        addLog('Connected to backend WebSocket telemetry');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleLiveEvent(data);
        } catch {}
      };

      ws.onerror = () => {
        console.warn('WebSocket connection unavailable, using polling fallback');
      };
    } catch {}

    return () => {
      clearInterval(interval);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const handleLiveEvent = (event) => {
    if (event.type === 'PACKET_HOP') {
      setActiveHop({ from: event.from, to: event.to });
      setTimeout(() => setActiveHop(null), 600);
      addLog(`Hop: ${event.from} ➔ ${event.to} (TTL: ${event.ttl})`);
    } else if (event.type === 'PACKET_INJECTED') {
      addLog(`Packet injected at ${event.deviceId || event.nodeId} (TTL: ${event.ttl})`);
      refreshData();
    } else if (event.type === 'GOSSIP_COMPLETED') {
      addLog(`Gossip completed: ${event.transfers} transfer(s) across mesh`);
      refreshData();
    } else if (event.type === 'PACKET_TAMPERED') {
      addLog(`🚨 Rogue node ${event.rogueNode} tampered with ciphertext in transit!`);
    } else if (event.type === 'MESH_RESET') {
      addLog('Mesh devices and idempotency cache reset');
      refreshData();
    }
  };

  const handleManualSend = async (payload) => {
    setIsOperating(true);
    try {
      const res = await fetch('/api/demo/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((r) => r.json());

      addLog(`📤 Payment packet ${res.packetId.substring(0, 8)} encrypted and injected at ${res.injectedAt}`);
      await refreshData();
    } catch (err) {
      addLog(`❌ Failed to send packet: ${err.message}`);
    } finally {
      setIsOperating(false);
    }
  };

  const handleGossip = async () => {
    setIsOperating(true);
    try {
      const res = await fetch('/api/mesh/gossip', { method: 'POST' }).then((r) => r.json());
      addLog(`🔄 Gossip round: ${res.transfers} transfers across nodes`);
      await refreshData();
    } catch (err) {
      addLog(`❌ Gossip failed: ${err.message}`);
    } finally {
      setIsOperating(false);
    }
  };

  const handleFlushBridges = async () => {
    setIsOperating(true);
    try {
      const res = await fetch('/api/mesh/flush', { method: 'POST' }).then((r) => r.json());
      addLog(`📡 4G Bridge flush: ${res.uploadsAttempted} upload(s) executed`);
      res.results.forEach((r) => {
        addLog(`   Node ${r.bridgeNode} packet ${r.packetId} ➔ ${r.outcome} ${r.reason ? `(${r.reason})` : ''}`);
        if (r.outcome === 'SETTLED') {
          confetti({ particleCount: 50, spread: 60, origin: { y: 0.7 } });
        }
      });
      await refreshData();
    } catch (err) {
      addLog(`❌ Flush failed: ${err.message}`);
    } finally {
      setIsOperating(false);
    }
  };

  const handleResetMesh = async () => {
    setIsOperating(true);
    try {
      await fetch('/api/mesh/reset', { method: 'POST' });
      addLog('🗑 Mesh and idempotency cache cleared');
      await refreshData();
    } catch (err) {
      addLog(`❌ Reset failed: ${err.message}`);
    } finally {
      setIsOperating(false);
    }
  };

  const handleRunScenario = async (scenarioName) => {
    setIsOperating(true);
    addLog(`🎬 Running scenario: ${scenarioName.toUpperCase()}...`);

    try {
      if (scenarioName === 'normal') {
        // Step 1: Send
        await fetch('/api/demo/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            senderVpa: 'alice@demo',
            receiverVpa: 'bob@demo',
            amount: 150.0,
            pin: '1234',
            ttl: 5,
            startDevice: 'phone-alice',
          }),
        });
        addLog('Step 1: Alice creates ₹150 encrypted payment');
        await new Promise((r) => setTimeout(r, 400));
        await refreshData();

        // Step 2: Gossip
        await fetch('/api/mesh/gossip', { method: 'POST' });
        addLog('Step 2: Gossiping packet across basement nodes...');
        await new Promise((r) => setTimeout(r, 400));
        await refreshData();

        // Step 3: Flush
        const flushRes = await fetch('/api/mesh/flush', { method: 'POST' }).then((r) => r.json());
        addLog(`Step 3: Bridge node uploads to backend ➔ ${flushRes.results[0]?.outcome || 'SETTLED'}`);
        confetti({ particleCount: 70, spread: 70, origin: { y: 0.6 } });
        await refreshData();
      } else if (scenarioName === 'duplicate') {
        // Step 1: Send
        await fetch('/api/demo/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            senderVpa: 'alice@demo',
            receiverVpa: 'carol@demo',
            amount: 250.0,
            pin: '1234',
            ttl: 5,
          }),
        });
        addLog('Step 1: Injected payment packet');
        // Gossip twice to spread to multiple nodes
        await fetch('/api/mesh/gossip', { method: 'POST' });
        await fetch('/api/mesh/gossip', { method: 'POST' });
        addLog('Step 2: Gossiped to multiple devices. Bridges simultaneously upload...');

        // Flush in parallel
        const flushRes = await fetch('/api/mesh/flush', { method: 'POST' }).then((r) => r.json());
        addLog(`Step 3: Parallel uploads processed!`);
        flushRes.results.forEach((r) => {
          addLog(`   ${r.bridgeNode}: outcome ➔ ${r.outcome}`);
        });
        await refreshData();
      } else if (scenarioName === 'tampered') {
        addLog('Step 1: Generating and tampering packet with flipped bits...');
        // Create tampered packet directly at /api/bridge/ingest
        const keyRes = await fetch('/api/server-key').then((r) => r.json());
        // Ingest dummy tampered payload
        const tamperedPacket = {
          packetId: crypto.randomUUID ? crypto.randomUUID() : 'tampered-' + Date.now(),
          ttl: 4,
          createdAt: Date.now(),
          ciphertext: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8w',
        };
        const ingestRes = await fetch('/api/bridge/ingest', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bridge-Node-Id': 'phone-rogue',
            'X-Hop-Count': '3',
          },
          body: JSON.stringify(tamperedPacket),
        }).then((r) => r.json());

        addLog(`Step 2: Backend evaluated tampered packet ➔ ${ingestRes.outcome} (${ingestRes.reason})`);
        addLog(`🛡️ Rogue node penalized in reputation registry.`);
        await refreshData();
      } else if (scenarioName === 'replay') {
        addLog('Step 1: Ingesting expired 30-hour old packet...');
        const stalePacket = {
          packetId: 'stale-' + Date.now(),
          ttl: 4,
          createdAt: Date.now() - 30 * 3600 * 1000,
          ciphertext: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8w',
        };
        const res = await fetch('/api/bridge/ingest', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bridge-Node-Id': 'phone-bridge-1',
            'X-Hop-Count': '2',
          },
          body: JSON.stringify(stalePacket),
        }).then((r) => r.json());

        addLog(`Step 2: Backend freshness check ➔ ${res.outcome} (${res.reason})`);
        await refreshData();
      } else if (scenarioName === 'velocity') {
        addLog('Step 1: Rapid offline payment velocity burst (4 micro-payments of ₹50)...');
        for (let i = 1; i <= 4; i++) {
          await fetch('/api/demo/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              senderVpa: 'alice@demo',
              receiverVpa: 'bob@demo',
              amount: 50.0,
              pin: '1234',
              ttl: 4,
            }),
          });
        }
        await fetch('/api/mesh/gossip', { method: 'POST' });
        await fetch('/api/mesh/flush', { method: 'POST' });
        addLog('Step 2: Baseline velocity established. Injecting ₹4,500 spike via multi-hop sketchy relay...');

        const spikeRes = await fetch('/api/demo/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            senderVpa: 'alice@demo',
            receiverVpa: 'carol@demo',
            amount: 4500.0,
            pin: '1234',
            ttl: 1,
          }),
        }).then((r) => r.json());

        if (spikeRes.packet) {
          const ingestRes = await fetch('/api/bridge/ingest', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Bridge-Node-Id': 'sketchy-relay',
              'X-Hop-Count': '8',
            },
            body: JSON.stringify(spikeRes.packet),
          }).then((r) => r.json());

          addLog(`Step 3: AI Fraud Engine evaluated packet ➔ ${ingestRes.outcome} (Risk Score: ${ingestRes.riskScore}/100)`);
          addLog(`⚠️ Payment held in AI Risk Queue! Authorize or reject below.`);
        }
        await refreshData();
      }
    } catch (err) {
      addLog(`❌ Scenario error: ${err.message}`);
    } finally {
      setIsOperating(false);
    }
  };

  const handleReviewFlagged = async (id, decision) => {
    setIsReviewing(true);
    try {
      const res = await fetch(`/api/flagged/${id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      }).then((r) => r.json());

      addLog(`Human review applied: ${decision.toUpperCase()} ➔ ${res.outcome}`);
      if (decision === 'approve') {
        confetti({ particleCount: 60, spread: 60, origin: { y: 0.5 } });
      }
      await refreshData();
    } catch (err) {
      addLog(`❌ Review failed: ${err.message}`);
    } finally {
      setIsReviewing(false);
    }
  };

  return (
    <div className="dashboard-container">
      {/* Header */}
      <header className="dashboard-header">
        <div className="brand-wrapper">
          <div className="brand-icon">
            <Radio size={24} />
          </div>
          <div>
            <h1 className="brand-title">UPI Offline Mesh</h1>
            <p className="brand-subtitle">
              Mission Control • Bluetooth Mesh Relay • Exactly-Once Settlement • AI Risk Scoring
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div className="status-badge">
            <span className="pulse-dot"></span>
            <span>Mesh Live</span>
          </div>
          <button className="btn btn-secondary" onClick={refreshData} title="Refresh Dashboard">
            <RefreshCw size={14} />
            Sync
          </button>
        </div>
      </header>

      {/* Grid Top: Visualizer + Controls */}
      <div className="grid-top">
        <div className="glass-card">
          <div className="card-header">
            <div className="card-title-group">
              <Radio size={18} color="#10b981" />
              <h3 className="card-title">Live Bluetooth Mesh Topology</h3>
            </div>
            <span className="badge-counter">{devices.length || 8} Active Nodes</span>
          </div>
          <MeshGraphCanvas devices={devices} activeHop={activeHop} />
        </div>

        <DemoControls
          onRunScenario={handleRunScenario}
          onManualSend={handleManualSend}
          onGossip={handleGossip}
          onFlushBridges={handleFlushBridges}
          onResetMesh={handleResetMesh}
          isOperating={isOperating}
        />
      </div>

      {/* Grid Middle: Risk Queue + Accounts */}
      <div className="grid-middle">
        <RiskQueuePanel
          flagged={flagged}
          onReview={handleReviewFlagged}
          isReviewing={isReviewing}
        />

        <AccountBalances
          accounts={accounts}
          idempotencyCacheSize={idempotencyCacheSize}
        />
      </div>

      {/* Grid Bottom: Ledger + Activity Terminal */}
      <div className="grid-bottom">
        <SettlementFeed transactions={transactions} />
        <ActivityLog logs={logs} />
      </div>
    </div>
  );
}
