import React from 'react';
import { ShieldAlert, Check, X, AlertTriangle } from 'lucide-react';

export function RiskQueuePanel({ flagged = [], onReview, isReviewing = false }) {
  return (
    <div className="glass-card">
      <div className="card-header">
        <div className="card-title-group">
          <ShieldAlert size={18} color="#c084fc" />
          <h3 className="card-title">AI Fraud & Anomaly Risk Queue</h3>
        </div>
        <span
          className="badge-counter"
          style={{
            background: flagged.length > 0 ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255, 255, 255, 0.08)',
            color: flagged.length > 0 ? '#c084fc' : '#94a3b8',
          }}
        >
          {flagged.length} Flagged
        </span>
      </div>

      {flagged.length === 0 ? (
        <div style={{ padding: '28px', textAlign: 'center', color: '#64748b' }}>
          <p style={{ fontSize: '13px' }}>🛡️ All clear. No transactions currently held by the AI risk engine.</p>
          <p style={{ fontSize: '11px', marginTop: '4px', color: '#475569' }}>
            Payments exceeding the anomaly threshold appear here for human authorization before ledger settlement.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {flagged.map((item) => {
            const id = item.id || item._id;
            const score = item.riskScore || 50;

            return (
              <div
                key={id}
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid rgba(168, 85, 247, 0.25)',
                  borderRadius: '10px',
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: '14px', color: '#fff' }}>
                      {item.senderVpa} → {item.receiverVpa}
                    </span>
                    <span className="currency" style={{ marginLeft: '10px', fontSize: '14px' }}>
                      ₹{Number(item.amount).toFixed(2)}
                    </span>
                  </div>

                  <div className="risk-meter risk-high">
                    <AlertTriangle size={13} />
                    <span>Risk: {score}/100</span>
                  </div>
                </div>

                {/* Factors */}
                <div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '4px' }}>
                    Contributing Anomaly Signals:
                  </div>
                  <div>
                    {item.contributingFactors?.map((factor, idx) => (
                      <span key={idx} className="risk-factor-pill">
                        ⚠️ {factor}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Actions */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '10px',
                    borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                    paddingTop: '10px',
                  }}
                >
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: '12px', padding: '6px 12px' }}
                    onClick={() => onReview(id, 'reject')}
                    disabled={isReviewing}
                  >
                    <X size={13} color="#f43f5e" />
                    Reject Payment
                  </button>
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: '12px', padding: '6px 14px' }}
                    onClick={() => onReview(id, 'approve')}
                    disabled={isReviewing}
                  >
                    <Check size={13} />
                    Authorize & Settle
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
