import React from 'react';
import { Terminal } from 'lucide-react';

export function ActivityLog({ logs = [] }) {
  return (
    <div className="glass-card">
      <div className="card-header">
        <div className="card-title-group">
          <Terminal size={18} color="#38bdf8" />
          <h3 className="card-title">Live Node Telemetry & Activity Log</h3>
        </div>
      </div>

      <div className="terminal-window">
        {logs.length === 0 ? (
          <div style={{ color: '#475569' }}>Awaiting mesh events...</div>
        ) : (
          logs.map((log, idx) => (
            <div key={idx} className="terminal-line">
              <span className="terminal-time">[{log.time}]</span>
              <span>{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
