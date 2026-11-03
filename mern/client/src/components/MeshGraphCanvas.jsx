import React from 'react';
import { Wifi, WifiOff, ShieldAlert, Smartphone } from 'lucide-react';

export function MeshGraphCanvas({ devices = [], activeHop = null, events = [] }) {
  // Device layout positions for SVG rendering
  const nodePositions = {
    'phone-alice': { x: 70, y: 190, label: 'Alice', type: 'sender' },
    'phone-stranger1': { x: 210, y: 100, label: 'Corridor 1', type: 'relay' },
    'phone-stranger2': { x: 210, y: 280, label: 'Staircase', type: 'relay' },
    'phone-rogue': { x: 360, y: 80, label: 'Rogue Node', type: 'rogue' },
    'phone-stranger3': { x: 360, y: 210, label: 'Elevator', type: 'relay' },
    'phone-bridge': { x: 520, y: 160, label: 'Bridge (4G)', type: 'bridge' },
    'phone-bridge1': { x: 520, y: 110, label: 'Bridge 1 (4G)', type: 'bridge' },
    'phone-bridge2': { x: 520, y: 240, label: 'Bridge 2 (4G)', type: 'bridge' },
    'phone-bob': { x: 210, y: 340, label: 'Bob', type: 'receiver' },
  };

  const links = [
    ['phone-alice', 'phone-stranger1'],
    ['phone-alice', 'phone-stranger2'],
    ['phone-stranger1', 'phone-rogue'],
    ['phone-stranger1', 'phone-stranger3'],
    ['phone-stranger2', 'phone-stranger3'],
    ['phone-stranger3', 'phone-bridge'],
    ['phone-stranger3', 'phone-bridge1'],
    ['phone-stranger3', 'phone-bridge2'],
    ['phone-rogue', 'phone-bridge1'],
    ['phone-rogue', 'phone-bridge'],
  ];

  // Map device packet counts
  const deviceCounts = {};
  for (const d of devices) {
    deviceCounts[d.deviceId] = d.packetCount || 0;
  }

  return (
    <div className="mesh-canvas-wrapper">
      <svg className="mesh-svg" viewBox="0 0 600 370">
        <defs>
          <linearGradient id="linkGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.4" />
          </linearGradient>
          <linearGradient id="activeLinkGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0.9" />
          </linearGradient>
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* Links */}
        {links.map(([fromId, toId], idx) => {
          const from = nodePositions[fromId];
          const to = nodePositions[toId];
          if (!from || !to) return null;

          const isActive =
            activeHop &&
            ((activeHop.from === fromId && activeHop.to === toId) ||
              (activeHop.from === toId && activeHop.to === fromId));

          return (
            <line
              key={idx}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={isActive ? 'url(#activeLinkGrad)' : 'rgba(255, 255, 255, 0.12)'}
              strokeWidth={isActive ? '3' : '1.5'}
              strokeDasharray={isActive ? '6 4' : 'none'}
            >
              {isActive && (
                <animate
                  attributeName="stroke-dashoffset"
                  from="20"
                  to="0"
                  dur="0.6s"
                  repeatCount="indefinite"
                />
              )}
            </line>
          );
        })}

        {/* Nodes */}
        {Object.entries(nodePositions).map(([id, pos]) => {
          const count = deviceCounts[id] || 0;
          const isBridge = pos.type === 'bridge' || id.includes('bridge');
          const isRogue = pos.type === 'rogue';
          const isSender = pos.type === 'sender';
          const isHighlighted = activeHop && (activeHop.from === id || activeHop.to === id);

          let strokeColor = '#3b82f6';
          let fillColor = '#111827';
          if (isBridge) strokeColor = '#10b981';
          if (isRogue) strokeColor = '#ef4444';
          if (isSender) strokeColor = '#06b6d4';

          return (
            <g key={id} transform={`translate(${pos.x}, ${pos.y})`}>
              {/* Outer pulsing ring if highlighted */}
              {isHighlighted && (
                <circle
                  r="24"
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth="2"
                  opacity="0.8"
                  filter="url(#glow)"
                >
                  <animate
                    attributeName="r"
                    values="18;28;18"
                    dur="1.2s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0.8;0.2;0.8"
                    dur="1.2s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}

              {/* Node Body */}
              <circle
                r="18"
                fill={fillColor}
                stroke={strokeColor}
                strokeWidth={isBridge ? '3' : '2'}
              />

              {/* Node Icon / Symbol */}
              {isBridge ? (
                <text x="0" y="4" textAnchor="middle" fill="#10b981" fontSize="12">
                  📶
                </text>
              ) : isRogue ? (
                <text x="0" y="4" textAnchor="middle" fill="#ef4444" fontSize="11">
                  ⚠️
                </text>
              ) : (
                <text x="0" y="4" textAnchor="middle" fill="#94a3b8" fontSize="11">
                  📱
                </text>
              )}

              {/* Packet Counter Badge */}
              {count > 0 && (
                <g transform="translate(12, -12)">
                  <circle r="9" fill="#f59e0b" />
                  <text
                    x="0"
                    y="3"
                    textAnchor="middle"
                    fill="#000"
                    fontSize="10"
                    fontWeight="bold"
                  >
                    {count}
                  </text>
                </g>
              )}

              {/* Node Label */}
              <text
                x="0"
                y="30"
                textAnchor="middle"
                fill="#e2e8f0"
                fontSize="11"
                fontWeight="600"
              >
                {pos.label}
              </text>
              <text
                x="0"
                y="42"
                textAnchor="middle"
                fill={isBridge ? '#34d399' : '#64748b'}
                fontSize="9"
              >
                {isBridge ? '🌐 4G Bridge' : '🚫 Offline Mesh'}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
