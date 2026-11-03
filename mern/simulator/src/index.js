import { WebSocketServer } from 'ws';
import { MeshNetwork } from './meshNetwork.js';
import { ScenarioRunner } from './scenarios.js';

const SIMULATOR_WS_PORT = parseInt(process.env.SIMULATOR_WS_PORT || '8085', 10);
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';

const network = new MeshNetwork({ dropRate: 0.05, hopDelayMs: 250 });
const runner = new ScenarioRunner({ network, serverUrl: SERVER_URL });

// Setup WebSocket server for React Dashboard live integration
const wss = new WebSocketServer({ port: SIMULATOR_WS_PORT }, () => {
  console.log(`📡 UPI Mesh Simulator WebSocket active on ws://localhost:${SIMULATOR_WS_PORT}`);
});

wss.on('connection', (ws) => {
  console.log('Client connected to simulator WebSocket.');

  // Send current topology
  ws.send(
    JSON.stringify({
      type: 'TOPOLOGY_UPDATE',
      topology: network.getTopology(),
    })
  );

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.action === 'RUN_SCENARIO') {
        console.log(`Running scenario: ${msg.scenario}`);
        const result = await runner.runScenario(msg.scenario);
        ws.send(JSON.stringify({ type: 'SCENARIO_RESULT', scenario: msg.scenario, result }));
      } else if (msg.action === 'RESET_MESH') {
        network.reset();
        ws.send(JSON.stringify({ type: 'MESH_RESET' }));
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
      ws.send(JSON.stringify({ type: 'ERROR', message: err.message }));
    }
  });
});

// Broadcast all network events to connected dashboards
network.onEvent((event) => {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
});

// CLI Scenario Execution support
const scenarioArg = process.argv.find((a) => a.startsWith('--scenario='));
if (scenarioArg) {
  const scenarioName = scenarioArg.split('=')[1];
  console.log(`Starting standalone scenario: ${scenarioName}...`);
  setTimeout(async () => {
    try {
      const res = await runner.runScenario(scenarioName);
      console.log('Scenario completed successfully:', res);
    } catch (err) {
      console.error('Scenario failed:', err.message);
    }
  }, 1000);
}
