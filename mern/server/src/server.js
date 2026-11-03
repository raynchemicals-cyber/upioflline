import 'dotenv/config';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { connectDb } from './config/db.js';
import { demoService } from './services/demoService.js';
import { meshSimulatorService } from './services/meshSimulatorService.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

async function start() {
  await connectDb();
  await demoService.seedAccounts();

  const app = createApp();
  const server = http.createServer(app);

  // Setup WebSocket server for live dashboard events
  const wss = new WebSocketServer({ server, path: '/ws/mesh' });

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'INIT',
        devices: meshSimulatorService.getDevices().map((d) => ({
          deviceId: d.deviceId,
          hasInternet: d.hasInternet,
          packetCount: d.packetCount(),
        })),
      })
    );
  });

  meshSimulatorService.onEvent((event) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  });

  server.listen(PORT, () => {
    console.log(`UPI Offline Mesh MERN Server running on http://localhost:${PORT}`);
    console.log(`WebSocket server active on ws://localhost:${PORT}/ws/mesh`);
  });
}

start().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
