import React, { useState } from 'react';
import { Play, Repeat, ShieldCheck, Zap, AlertTriangle, Send, RefreshCw, Trash2 } from 'lucide-react';

export function DemoControls({
  onRunScenario,
  onManualSend,
  onGossip,
  onFlushBridges,
  onResetMesh,
  isOperating = false,
}) {
  const [senderVpa, setSenderVpa] = useState('alice@demo');
  const [receiverVpa, setReceiverVpa] = useState('bob@demo');
  const [amount, setAmount] = useState(500);
  const [pin, setPin] = useState('1234');

  const handleSend = (e) => {
    e.preventDefault();
    onManualSend({
      senderVpa,
      receiverVpa,
      amount: parseFloat(amount),
      pin,
      ttl: 5,
      startDevice: 'phone-alice',
    });
  };

  return (
    <div className="glass-card">
      <div className="card-header">
        <div className="card-title-group">
          <Zap size={18} color="#f59e0b" />
          <h3 className="card-title">Mesh Control & Demo Scenarios</h3>
        </div>
      </div>

      {/* Scenarios Grid */}
      <div>
        <div style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', marginBottom: '8px' }}>
          Interactive Demonstration Scenarios:
        </div>
        <div className="scenarios-grid">
          <button
            className="scenario-card-btn"
            onClick={() => onRunScenario('normal')}
            disabled={isOperating}
          >
            <div className="scenario-btn-title">
              <Play size={14} color="#10b981" />
              <span>1. Normal Payment</span>
            </div>
            <div className="scenario-btn-desc">
              Alice sends ₹150 to Bob. Encrypted packet hops to 4G bridge and settles.
            </div>
          </button>

          <button
            className="scenario-card-btn"
            onClick={() => onRunScenario('duplicate')}
            disabled={isOperating}
          >
            <div className="scenario-btn-title">
              <Repeat size={14} color="#f59e0b" />
              <span>2. Duplicate Delivery</span>
            </div>
            <div className="scenario-btn-desc">
              Same packet hits 2 bridges simultaneously. Exactly 1 settles, 1 dropped.
            </div>
          </button>

          <button
            className="scenario-card-btn"
            onClick={() => onRunScenario('tampered')}
            disabled={isOperating}
          >
            <div className="scenario-btn-title">
              <AlertTriangle size={14} color="#f43f5e" />
              <span>3. Tampered Packet</span>
            </div>
            <div className="scenario-btn-desc">
              Rogue intermediary flips bits. AES-GCM tag verification throws exception.
            </div>
          </button>

          <button
            className="scenario-card-btn"
            onClick={() => onRunScenario('replay')}
            disabled={isOperating}
          >
            <div className="scenario-btn-title">
              <ShieldCheck size={14} color="#06b6d4" />
              <span>4. Stale Replay</span>
            </div>
            <div className="scenario-btn-desc">
              Injects a 28-hour old packet. 24h freshness window rejects replay.
            </div>
          </button>

          <button
            className="scenario-card-btn"
            onClick={() => onRunScenario('velocity')}
            disabled={isOperating}
          >
            <div className="scenario-btn-title">
              <Zap size={14} color="#c084fc" />
              <span>5. Velocity Burst</span>
            </div>
            <div className="scenario-btn-desc">
              6 offline payments in rapid succession. AI engine flags risk anomaly.
            </div>
          </button>
        </div>
      </div>

      {/* Manual Payment Injector */}
      <div
        style={{
          marginTop: '20px',
          paddingTop: '16px',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        <div style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', marginBottom: '8px' }}>
          Manual Offline Payment Injection:
        </div>
        <form
          onSubmit={handleSend}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '10px',
            alignItems: 'center',
          }}
        >
          <select
            value={senderVpa}
            onChange={(e) => setSenderVpa(e.target.value)}
            style={{
              background: '#090d16',
              color: '#fff',
              border: '1px solid var(--border-subtle)',
              borderRadius: '6px',
              padding: '8px 12px',
              fontSize: '13px',
            }}
          >
            <option value="alice@demo">alice@demo</option>
            <option value="bob@demo">bob@demo</option>
            <option value="carol@demo">carol@demo</option>
          </select>

          <span style={{ color: '#64748b' }}>→</span>

          <select
            value={receiverVpa}
            onChange={(e) => setReceiverVpa(e.target.value)}
            style={{
              background: '#090d16',
              color: '#fff',
              border: '1px solid var(--border-subtle)',
              borderRadius: '6px',
              padding: '8px 12px',
              fontSize: '13px',
            }}
          >
            <option value="bob@demo">bob@demo</option>
            <option value="carol@demo">carol@demo</option>
            <option value="alice@demo">alice@demo</option>
            <option value="dave@demo">dave@demo</option>
          </select>

          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ color: '#94a3b8', fontSize: '13px' }}>₹</span>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{
                width: '90px',
                background: '#090d16',
                color: '#fff',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                padding: '8px 10px',
                fontSize: '13px',
              }}
              min="1"
            />
          </div>

          <input
            type="password"
            value={pin}
            maxLength={4}
            placeholder="PIN"
            onChange={(e) => setPin(e.target.value)}
            style={{
              width: '60px',
              background: '#090d16',
              color: '#fff',
              border: '1px solid var(--border-subtle)',
              borderRadius: '6px',
              padding: '8px 10px',
              fontSize: '13px',
              textAlign: 'center',
            }}
          />

          <button type="submit" className="btn btn-primary" disabled={isOperating}>
            <Send size={13} />
            Inject into Mesh
          </button>
        </form>
      </div>

      {/* Manual Mesh Step Operations */}
      <div
        style={{
          display: 'flex',
          gap: '10px',
          marginTop: '16px',
          paddingTop: '14px',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        <button className="btn btn-secondary" onClick={onGossip} disabled={isOperating}>
          <Repeat size={13} />
          Run Gossip Round
        </button>
        <button className="btn btn-secondary" onClick={onFlushBridges} disabled={isOperating}>
          <RefreshCw size={13} />
          Bridges Upload to 4G
        </button>
        <button className="btn btn-danger" onClick={onResetMesh} disabled={isOperating}>
          <Trash2 size={13} />
          Reset Mesh & Cache
        </button>
      </div>
    </div>
  );
}
