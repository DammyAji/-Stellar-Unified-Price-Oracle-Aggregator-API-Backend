import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { webhookService, type WebhookRegistration } from './webhook-service';
import { links, withLinks } from '../price-serving/hypermedia';
import { sendError } from '../infrastructure/error';

const router = Router();

const RegisterSchema = z.object({
  url: z.string().url(),
  trigger: z.object({
    type: z.enum(['threshold', 'interval']),
    asset: z.string().min(1),
    value: z.number().positive(),
  }),
});

const ReplaySchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
});

function keyPrefixOf(req: Request): string {
  return req.apiKey ? req.apiKey.substring(0, 8) : 'anonymous';
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err: unknown) => {
      sendError(res, err, { path: req.path, method: req.method, requestId: req.requestId });
    });
  };
}

function notFound(res: Response): void {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Webhook not found' } });
}

router.post('/', (req: Request, res: Response) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
    });
  }

  const webhook = webhookService.register(
    parsed.data.url,
    keyPrefixOf(req),
    { ...parsed.data.trigger, asset: parsed.data.trigger.asset.toUpperCase() },
  );

  res.status(201).json({
    success: true,
    data: {
      ...withLinks(webhook, links.webhook(webhook.id)),
      verificationKey: webhook.verificationKey,
      status: webhook.status,
      failureCount: webhook.failureCount,
    },
  });
});

router.get('/', (req: Request, res: Response) => {
  const data = webhookService.list(keyPrefixOf(req)).map((w: WebhookRegistration) => withLinks(w, links.webhook(w.id)));
  res.json({ success: true, data, _links: links.root() });
});

router.get('/verification-key', (_req: Request, res: Response) => {
  res.json({ success: true, data: { verificationKey: crypto.createHash('sha256').update(process.env.WEBHOOK_SIGNING_SECRET || 'default').digest('hex') } });
});

router.get('/dead-letters', asyncRoute(async (req, res) => {
  const data = await webhookService.listDeadLetters(keyPrefixOf(req));
  res.json({ success: true, data, _links: links.root() });
}));

router.get('/dead-letters/:id', asyncRoute(async (req, res) => {
  const entry = await webhookService.getDeadLetter(req.params.id);
  if (!entry || entry.apiKeyPrefix !== keyPrefixOf(req)) {
    notFound(res);
    return;
  }
  res.json({ success: true, data: entry });
}));

router.post('/dead-letters/:id/replay', asyncRoute(async (req, res) => {
  const headerKey = req.header('Idempotency-Key');
  const parsed = ReplaySchema.safeParse({ idempotencyKey: req.body?.idempotencyKey ?? headerKey });
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'idempotencyKey is required (body field or Idempotency-Key header)',
      },
    });
    return;
  }

  const existing = await webhookService.getDeadLetter(req.params.id);
  if (!existing || existing.apiKeyPrefix !== keyPrefixOf(req)) {
    notFound(res);
    return;
  }

  const result = await webhookService.replay(req.params.id, parsed.data.idempotencyKey);
  if (result.status === 'missing') {
    notFound(res);
    return;
  }
  if (result.status === 'failed') {
    res.status(502).json({
      success: false,
      error: { code: 'DELIVERY_FAILED', message: result.failure || 'Replay delivery failed' },
      data: result.entry,
    });
    return;
  }
  res.json({ success: true, data: { status: result.status, entry: result.entry } });
}));

router.get('/:id', (req: Request, res: Response) => {
  const webhook = webhookService.get(req.params.id);
  if (!webhook || webhook.apiKeyPrefix !== keyPrefixOf(req)) {
    notFound(res);
    return;
  }
  res.json({ success: true, data: withLinks(webhook, links.webhook(webhook.id)) });
});

router.delete('/:id', (req: Request, res: Response) => {
  const webhook = webhookService.get(req.params.id);
  if (!webhook || webhook.apiKeyPrefix !== keyPrefixOf(req)) {
    notFound(res);
    return;
  }
  webhookService.remove(req.params.id);
  res.status(204).send();
});

router.get('/:id/deliveries', asyncRoute(async (req, res) => {
  const webhook = webhookService.get(req.params.id);
  if (!webhook || webhook.apiKeyPrefix !== keyPrefixOf(req)) {
    notFound(res);
    return;
  }
  const limitRaw = req.query.limit;
  const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : undefined;
  const sinceRaw = req.query.since;
  const since = typeof sinceRaw === 'string' ? parseInt(sinceRaw, 10) : undefined;
  const data = await webhookService.deliveries(req.params.id, {
    limit: Number.isFinite(limit) ? limit : undefined,
    since: Number.isFinite(since) ? since : undefined,
  });
  res.json({ success: true, data });
}));

export default router;
