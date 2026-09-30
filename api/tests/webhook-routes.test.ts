import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import webhooksRouter from '../src/webhooks/webhooks';
import { webhookService } from '../src/webhooks/webhook-service';
import type { WebhookTrigger } from '../src/webhooks/webhook-service';

const API_KEY = 'route-key-abcdef123456';
const PREFIX = API_KEY.substring(0, 8);

const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.apiKey = req.header('x-api-key') ?? API_KEY;
    next();
  });
  app.use('/api/v1/webhooks', webhooksRouter);
  return app;
}

describe('Webhook dead-letter routes (issue #601)', () => {
  let app: express.Express;
  let failMock: ReturnType<typeof vi.fn>;
  let okMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.env.WEBHOOK_DATA_DIR = path.resolve(__dirname, '../data/webhooks-test/routes');
    await webhookService.reset();
    failMock = vi.fn(() => Promise.reject(new Error('connection refused')));
    vi.stubGlobal('fetch', failMock);
    app = buildApp();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await webhookService.reset();
  });

  async function registerFailingWebhook(): Promise<string> {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .send({ url: 'https://hooks.example.com/routes', trigger });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  it('lists dead letters for the calling key only', async () => {
    const webhookId = await registerFailingWebhook();
    await webhookService.flush();

    const before = await request(app).get('/api/v1/webhooks/dead-letters');
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual([]);

    const webhook = webhookService.get(webhookId)!;
    await webhookService.deliver(webhook, { asset: 'XLM', price: '1' });

    const after = await request(app).get('/api/v1/webhooks/dead-letters');
    expect(after.status).toBe(200);
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].webhookId).toBe(webhookId);
    expect(after.body.data[0].apiKeyPrefix).toBe(PREFIX);
    expect(after.body.data[0].payload).toEqual({ asset: 'XLM', price: '1' });
  });

  it('replays a dead letter and returns duplicate on a second call', async () => {
    const webhookId = await registerFailingWebhook();
    await webhookService.flush();
    const webhook = webhookService.get(webhookId)!;
    await webhookService.deliver(webhook, { asset: 'XLM', price: '2' });

    const [entry] = (await request(app).get('/api/v1/webhooks/dead-letters')).body.data;

    okMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', okMock);

    const first = await request(app)
      .post(`/api/v1/webhooks/dead-letters/${entry.id}/replay`)
      .send({ idempotencyKey: 'route-idem-1' });
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('replayed');

    const second = await request(app)
      .post(`/api/v1/webhooks/dead-letters/${entry.id}/replay`)
      .send({ idempotencyKey: 'route-idem-2' });
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe('duplicate');
    expect(okMock).toHaveBeenCalledTimes(1);
  });

  it('accepts the Idempotency-Key header and rejects a missing key', async () => {
    const webhookId = await registerFailingWebhook();
    await webhookService.flush();
    const webhook = webhookService.get(webhookId)!;
    await webhookService.deliver(webhook, { asset: 'XLM', price: '3' });
    const [entry] = (await request(app).get('/api/v1/webhooks/dead-letters')).body.data;

    const missing = await request(app)
      .post(`/api/v1/webhooks/dead-letters/${entry.id}/replay`)
      .send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');

    okMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', okMock);
    const viaHeader = await request(app)
      .post(`/api/v1/webhooks/dead-letters/${entry.id}/replay`)
      .set('Idempotency-Key', 'route-header-key');
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.data.entry.replayId).toBe('route-header-key');
  });

  it('404s unknown and foreign dead letters', async () => {
    const unknown = await request(app).get('/api/v1/webhooks/dead-letters/does-not-exist');
    expect(unknown.status).toBe(404);

    const replayUnknown = await request(app)
      .post('/api/v1/webhooks/dead-letters/does-not-exist/replay')
      .send({ idempotencyKey: 'k' });
    expect(replayUnknown.status).toBe(404);

    const webhookId = await registerFailingWebhook();
    await webhookService.flush();
    const webhook = webhookService.get(webhookId)!;
    await webhookService.deliver(webhook, { asset: 'XLM', price: '4' });
    const [entry] = (await request(app).get('/api/v1/webhooks/dead-letters')).body.data;

    const foreign = await request(app)
      .get(`/api/v1/webhooks/dead-letters/${entry.id}`)
      .set('x-api-key', 'someone-else-key');
    expect(foreign.status).toBe(404);
  });

  it('returns durable per-webhook delivery history', async () => {
    const webhookId = await registerFailingWebhook();
    await webhookService.flush();
    const webhook = webhookService.get(webhookId)!;
    await webhookService.deliver(webhook, { asset: 'XLM', price: '5' });

    const res = await request(app).get(`/api/v1/webhooks/${webhookId}/deliveries`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((d: { webhookId: string }) => d.webhookId === webhookId)).toBe(true);

    const limited = await request(app).get(`/api/v1/webhooks/${webhookId}/deliveries?limit=1`);
    expect(limited.body.data).toHaveLength(1);

    const foreign = await request(app)
      .get(`/api/v1/webhooks/${webhookId}/deliveries`)
      .set('x-api-key', 'someone-else-key');
    expect(foreign.status).toBe(404);
  });
});
