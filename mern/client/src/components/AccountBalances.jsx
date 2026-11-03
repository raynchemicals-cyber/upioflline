import React from 'react';
import { Wallet, Shield } from 'lucide-react';

export function AccountBalances({ accounts = [], idempotencyCacheSize = 0 }) {
  return (
    <div className="glass-card">
      <div className="card-header">
        <div className="card-title-group">
          <Wallet size={18} color="#06b6d4" />
          <h3 className="card-title">Account Balances & Cache</h3>
        </div>
        <div
          style={{
            fontSize: '11px',
            background: 'rgba(255, 255, 255, 0.05)',
            padding: '3px 8px',
            borderRadius: '10px',
            color: '#94a3b8',
          }}
        >
          Idempotency Cache: {idempotencyCacheSize} hashes
        </div>
      </div>

      <table className="custom-table">
        <thead>
          <tr>
            <th>VPA</th>
            <th>Holder</th>
            <th style={{ textAlign: 'right' }}>Balance</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((acc) => (
            <tr key={acc.vpa}>
              <td className="mono" style={{ fontWeight: 600 }}>
                {acc.vpa}
              </td>
              <td style={{ color: '#94a3b8' }}>{acc.holderName}</td>
              <td className="currency" style={{ textAlign: 'right', fontSize: '14px' }}>
                ₹{Number(acc.balance).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
