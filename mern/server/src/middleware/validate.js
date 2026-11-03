import { z } from 'zod';

export const meshPacketSchema = z.object({
  packetId: z.string().min(1, 'packetId is required'),
  ttl: z.number().int().min(0, 'ttl must be non-negative'),
  createdAt: z.number().int().positive('createdAt must be a positive timestamp'),
  ciphertext: z.string().min(1, 'ciphertext is required'),
});

export const demoSendSchema = z.object({
  senderVpa: z.string().min(1, 'senderVpa is required'),
  receiverVpa: z.string().min(1, 'receiverVpa is required'),
  amount: z.number().positive('amount must be positive'),
  pin: z.string().default('1234'),
  ttl: z.number().int().min(0).default(5).optional(),
  startDevice: z.string().default('phone-alice').optional(),
});

export const reviewDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject'], {
    errorMap: () => ({ message: 'Decision must be either "approve" or "reject"' }),
  }),
});

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: result.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}
