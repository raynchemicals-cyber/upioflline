import { Router } from 'express';
import { apiController } from '../controllers/apiController.js';
import {
  validateBody,
  meshPacketSchema,
  demoSendSchema,
  reviewDecisionSchema,
} from '../middleware/validate.js';

const router = Router();

// RSA Key
router.get('/server-key', apiController.getServerPublicKey);

// Demo Sender Phone Simulation
router.post('/demo/send', validateBody(demoSendSchema), apiController.demoSend);

// Mesh Simulator Controls
router.get('/mesh/state', apiController.meshState);
router.post('/mesh/gossip', apiController.meshGossip);
router.post('/mesh/flush', apiController.meshFlush);
router.post('/mesh/reset', apiController.meshReset);

// Bridge Node Ingestion Endpoint (The primary production API)
router.post('/bridge/ingest', validateBody(meshPacketSchema), apiController.ingest);

// Ledger & Balances
router.get('/accounts', apiController.listAccounts);
router.get('/transactions', apiController.listTransactions);

// AI Fraud & Risk Review Endpoints
router.get('/flagged', apiController.listFlagged);
router.post('/flagged/:id/review', validateBody(reviewDecisionSchema), apiController.reviewFlagged);

export default router;
