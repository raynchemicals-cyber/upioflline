import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import apiRouter from './routes/api.js';
import { errorHandler } from './middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Mount API router at /api matching Java controller mapping
  app.use('/api', apiRouter);

  // Serve compiled React Vite frontend if present
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
        return next();
      }
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    // Fallback status page
    app.get('/', (req, res) => {
      res.json({
        name: 'UPI Offline Mesh MERN Backend',
        status: 'ONLINE',
        docs: '/api/server-key',
      });
    });
  }

  // Central error handler
  app.use(errorHandler);

  return app;
}
