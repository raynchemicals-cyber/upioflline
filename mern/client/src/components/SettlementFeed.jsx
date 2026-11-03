import React from 'react';
import { CheckCircle2, AlertOctagon, Copy, Clock, Layers } from 'lucide-react';

export function SettlementFeed({ transactions = [] }) {
  const getBadgeClass = (status) => {
    switch (status) {
      case 'SETTLED':
        return 'badge-outcome badge-SETTLED';
      case 'DUPLICATE_DROPPED':
        return 'badge-outcome badge-DUPLICATE_DROPPED';
      case 'INVALID':
        return 'badge-outcome badge-INVALID';
      case 'FLAGGED':
        return 'badge-outcome badge-FLAGGED';
      default:
        return 'badge-outcome';
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'SETTLED':
        return <CheckCircle2 size={13} />;
      case 'DUPLICATE_DROPPED':
        return <Copy size={13} />;
      case 'INVALID':
      case 'REJECTED':
        return <AlertOctagon size={13} />;
      default:
        return <Clock size={13} />;
    }
  };

  return (
    <div className="glass-card" style={{ overflowX: 'auto' }}>
      <div className="card-header">
        <div className="card-title-group">
          <Layers size={18} color="#10b981" />
          <h3 className="card-title">Settlement Feed & Immutable Ledger</h3>
        </div>
        <span className="badge-counter">{transactions.length} Records</span>
      </div>

      {transactions.length === 0 ? (
        <div style={{ padding: '30px', textAlign: 'center', color: '#64748b' }}>
          No transactions settled yet. Run a scenario or inject an offline payment to begin.
        </div>
      ) : (
        <table className="custom-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Transfer</th>
              <th>Amount</th>
              <th>Outcome</th>
              <th>Bridge Node</th>
              <th>Hops</th>
              <th>Settled At</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx) => (
              <tr key={tx.id || tx._id || tx.packetHash}>
                <td className="mono" style={{ color: '#94a3b8' }}>
                  #{tx.id ?? '—'}
                </td>
                <td>
                  <span style={{ fontWeight: 600 }}>{tx.senderVpa}</span>
                  <span style={{ color: '#64748b', margin: '0 6px' }}>→</span>
                  <span>{tx.receiverVpa}</span>
                </td>
                <td className="currency">₹{Number(tx.amount).toFixed(2)}</td>
                <td>
                  <span className={getBadgeClass(tx.status)}>
                    {getStatusIcon(tx.status)}
                    {tx.status}
                  </span>
                </td>
                <td className="mono" style={{ fontSize: '12px' }}>
                  {tx.bridgeNodeId}
                </td>
                <td style={{ textAlign: 'center' }}>{tx.hopCount}</td>
                <td style={{ color: '#94a3b8', fontSize: '12px' }}>
                  {tx.settledAt ? new Date(tx.settledAt).toLocaleTimeString() : 'Just now'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
