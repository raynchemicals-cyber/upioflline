import React, { useState, useEffect } from 'react';
import { Shield, ShieldAlert, ShieldCheck, AlertTriangle } from 'lucide-react';

export function TrustScorePanel() {
  const [relays, setRelays] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchRelays = async () => {
    try {
      const res = await fetch('/api/relay-nodes');
      if (res.ok) {
        const data = await res.json();
        setRelays(data);
      }
    } catch (err) {
      console.error('Failed to fetch relay nodes:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRelays();
    const interval = setInterval(fetchRelays, 3000);
    return () => clearInterval(interval);
  }, []);

  const getBadge = (classification, score) => {
    if (classification === 'MALICIOUS' || score < 40) {
      return (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '11px',
            fontWeight: 700,
            background: 'rgba(244, 63, 94, 0.2)',
            color: '#f43f5e',
            border: '1px solid rgba(244, 63, 94, 0.4)',
          }}
        >
          <ShieldAlert size={12} />
          MALICIOUS
        </span>
      );
    }
    if (classification === 'UNRELIABLE' || score < 70) {
      return (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '11px',
            fontWeight: 700,
            background: 'rgba(245, 158, 11, 0.2)',
            color: '#f59e0b',
            border: '1px solid rgba(245, 158, 11, 0.4)',
          }}
        >
          <AlertTriangle size={12} />
          UNRELIABLE
        </span>
      );
    }
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '2px 8px',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: 700,
          background: 'rgba(16, 185, 129, 0.2)',
          color: '#10b981',
          border: '1px solid rgba(16, 185, 129, 0.4)',
        }}
      >
        <ShieldCheck size={12} />
        HONEST
      </span>
    );
  };

  return (
    <div className="glass-card" style={{ marginTop: '16px' }}>
      <div className="card-header">
        <div className="card-title-group">
          <Shield size={18} color="#06b6d4" />
          <h3 className="card-title">Relay Node Trust Registry (Dynamic EMA)</h3>
        </div>
        <span className="badge-counter">{relays.length} Relays Monitored</span>
      </div>

      <div style={{ overflowX: 'auto', marginTop: '10px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px' }}>Node ID</th>
              <th style={{ padding: '8px 12px' }}>Trust Score</th>
              <th style={{ padding: '8px 12px' }}>Classification</th>
              <th style={{ padding: '8px 12px' }}>Forwarded</th>
              <th style={{ padding: '8px 12px' }}>Tampered / Dropped</th>
              <th style={{ padding: '8px 12px' }}>Health Bar</th>
            </tr>
          </thead>
          <tbody>
            {relays.map((r) => {
              const score = typeof r.trustScore === 'number' ? r.trustScore : (r.score ?? 80);
              const barColor = score < 40 ? '#f43f5e' : score < 70 ? '#f59e0b' : '#10b981';
              return (
                <tr key={r.nodeId || r.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                    {r.nodeId || r.id}
                  </td>
                  <td style={{ padding: '10px 12px', fontWeight: 700, color: barColor }}>
                    {score.toFixed(1)} / 100
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    {getBadge(r.classification, score)}
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>
                    {r.forwardedOk ?? r.totalRelayed ?? 0}
                  </td>
                  <td style={{ padding: '10px 12px', color: r.invalidRelayed > 0 ? '#f43f5e' : 'var(--text-muted)' }}>
                    {r.invalidRelayed ?? 0} / {r.drops ?? 0}
                  </td>
                  <td style={{ padding: '10px 12px', width: '160px' }}>
                    <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${Math.max(2, Math.min(100, score))}%`,
                          height: '100%',
                          background: barColor,
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
