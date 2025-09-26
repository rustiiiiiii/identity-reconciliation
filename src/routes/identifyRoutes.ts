// src/routes/identifyRoutes.ts
import { Router } from 'express';
import { identifyHandler } from '../controllers/identifyController.js';

const router = Router();

router.post('/identify', identifyHandler);

export default router;
