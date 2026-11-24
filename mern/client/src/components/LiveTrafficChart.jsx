import React, { useState, useEffect } from 'react';
import { Activity, ArrowUpRight, CheckCircle2, XCircle, Copy, AlertOctagon, Clock, Zap } from 'lucide-react';

export function LiveTrafficChart() {
  const [metrics, setMetrics] = useState({
    counters: {
      sent: 0,
      delivered: 0,
      dropped: 0,
      duplicates: 0,
      rejectedTampered: 0,
      rejectedStale: 0,
      transmissions: 0,
    },
    hopStats: { mean: 0, max: 0, min: 0 },
    delayStats: { mean: 0, max: 0, min: 0 },
    overhead: 0,
    deliveryRate: 0,
    history: [],
  });

  useEffect(() => {
    // Try SSE stream
    let eventSource;
    try {
      eventSource = new EventSource('/api/metrics/stream');
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setMetrics(data);
        } catch {}
      };
      eventSource.onerror = () => {
        eventSource.close();
      };
    } catch {}

    // Polling fallback
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/metrics');
        if (res.ok) {
          const data = await res.json();
          setMetrics(data);
        }
      } catch {}
    }, 2000);

    return () => {
      if (eventSource) eventSource.close();
      clearInterval(interval);
    };
  }, []);

  const history = metrics.history || [];
  const maxVal = Math.max(1, ...history.map((h) => Math.max(h.sent || 0, h.delivered || 0, h.dropped || 0)));

  return (
    <div className="glass-card" style={{ marginTop: '16px' }}>
      <div className="card-header">
        <div className="card-title-group">
          <Activity size={18} color="#10b981" />
          <h3 className="card-title">Live Traffic & Security Stream (SSE)</h3>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span className="pulse-dot" style={{ background: '#10b981' }} />
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Streaming</span>
        </div>
      </div>

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: '12px',
          marginTop: '12px',
          marginBottom: '16px',
        }}
      >
        <div style={{ background: 'var(--bg-elevated)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <ArrowUpRight size={12} color="#06b6d4" /> Sent
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#f1f5f9', marginTop: '2px' }}>
            {metrics.counters.sent}
          </div>
        </div>

        <div style={{ background: 'var(--bg-elevated)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <CheckCircle2 size={12} color="#10b981" /> Delivered
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#10b981', marginTop: '2px' }}>
            {metrics.counters.delivered}
          </div>
        </div>

        <div style={{ background: 'var(--bg-elevated)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <XCircle size={12} color="#f43f5e" /> Dropped
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#f43f5e', marginTop: '2px' }}>
            {metrics.counters.dropped}
          </div>
        </div>

        <div style={{ background: 'var(--bg-elevated)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Copy size={12} color="#f59e0b" /> Duplicates
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#f59e0b', marginTop: '2px' }}>
            {metrics.counters.duplicates}
          </div>
        </div>

        <div style={{ background: 'var(--bg-elevated)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <AlertOctagon size={12} color="#f43f5e" /> Tampered
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#f43f5e', marginTop: '2px' }}>
            {metrics.counters.rejectedTampered}
          </div>
        </div>

        <div style={{ background: 'var(--bg-elevated)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Zap size={12} color="#6366f1" /> Overhead
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#6366f1', marginTop: '2px' }}>
            {metrics.overhead}x
          </div>
        </div>

        <div style={{ background: 'var(--bg-elevated)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Clock size={12} color="#94a3b8" /> Mean Latency
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#94a3b8', marginTop: '2px' }}>
            {metrics.delayStats?.mean || 0} ms
          </div>
        </div>
      </div>

      {/* SVG Time-Series Chart */}
      <div style={{ background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
          <span>Real-time Traffic Velocity</span>
          <div style={{ display: 'flex', gap: '12px' }}>
            <span style={{ color: '#06b6d4' }}>● Sent</span>
            <span style={{ color: '#10b981' }}>● Delivered</span>
            <span style={{ color: '#f43f5e' }}>● Dropped</span>
            <span style={{ color: '#f59e0b' }}>● Tampered</span>
          </div>
        </div>
        <svg style={{ width: '100%', height: '80px', overflow: 'visible' }}>
          {history.length > 1 && (
            <>
              {/* Sent Polyline */}
              <polyline
                fill="none"
                stroke="#06b6d4"
                strokeWidth="2"
                points={history
                  .map((h, i) => `${(i / (history.length - 1)) * 100}%,${70 - (h.sent / maxVal) * 60}`)
                  .join(' ')}
              />
              {/* Delivered Polyline */}
              <polyline
                fill="none"
                stroke="#10b981"
                strokeWidth="2"
                points={history
                  .map((h, i) => `${(i / (history.length - 1)) * 100}%,${70 - (h.delivered / maxVal) * 60}`)
                  .join(' ')}
              />
              {/* Dropped Polyline */}
              <polyline
                fill="none"
                stroke="#f43f5e"
                strokeWidth="1.5"
                strokeDasharray="3 3"
                points={history
                  .map((h, i) => `${(i / (history.length - 1)) * 100}%,${70 - (h.dropped / maxVal) * 60}`)
                  .join(' ')}
              />
            </>
          )}
        </svg>
      </div>
    </div>
  );
}
