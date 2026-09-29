import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express, type Router as ExpressRouter } from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

const { dsarPath, logDir, auditPath, archivePath } = vi.hoisted(() => {
  const base = `${process.env.TEMP || 'C:/Users/USER/AppData/Local/Temp'}/compliance-dsar-${process.pid}`;
  process.env.DSAR_STORE_PATH = `${base}/dsars.json`;
  process.env.COMPLIANCE_LOG_DIR = base;
  return {
    dsarPath: process.env.DSAR_STORE_PATH,
    logDir: base,
    auditPath: `${base}/compliance-audit.jsonl`,
    archivePath: `${base}/compliance-audit-archive.jsonl`,
  };
});

import complianceRouter, {
  enforceRetention,
  setDsarStore,
  hydrateDsars,
} from '../src/governance/compliance';
import { FileDsarStore } from '../src/governance/dsar-store';
import { apiKeyManager } from '../src/governance/api-key-manager';

describe('Data-subject requests (DSAR)', () => {
  let app: Express;
  let operatorKey: string;
  let viewerKey: string;

  const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

  function buildApp(router: ExpressRouter | unknown = complianceRouter): Express {
    const built = express();
    built.use(express.json());
    built.use(router as ExpressRouter);
    return built;
  }

  async function resetDsarState(): Promise<void> {
    if (fs.existsSync(dsarPath)) fs.unlinkSync(dsarPath);
    setDsarStore(new FileDsarStore(dsarPath));
    await hydrateDsars();
  }

  beforeAll(() => {
    operatorKey = apiKeyManager.generateKey(1000, 'dsar operator', 'free', 'operator').key;
    viewerKey = apiKeyManager.generateKey(1000, 'dsar viewer', 'free', 'viewer').key;
  });

  beforeEach(async () => {
    await resetDsarState();
    app = buildApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('files a DSAR with an operator key, assigns an owner, and audits it', async () => {
    const res = await request(app)
      .post('/data/subject/sub-1/requests')
      .set(auth(operatorKey))
      .send({ requestType: 'access' });

    expect(res.status).toBe(202);
    expect(res.body.data.request.status).toBe('received');
    expect(res.body.data.request.owner).toBe(operatorKey.substring(0, 8));
    expect(res.body.data.request.history).toEqual([
      expect.objectContaining({ from: 'created', to: 'received', actor: operatorKey.substring(0, 8) }),
    ]);

    const audit = fs.readFileSync(auditPath, 'utf8');
    expect(audit).toContain('"eventType":"data.subject_request"');
  });

  it('requires authentication for filing and viewing, and operator role for filing', async () => {
    const unauthenticated = await request(app)
      .post('/data/subject/sub-1/requests')
      .send({ requestType: 'access' });
    expect(unauthenticated.status).toBe(401);

    const viewer = await request(app)
      .post('/data/subject/sub-1/requests')
      .set(auth(viewerKey))
      .send({ requestType: 'access' });
    expect(viewer.status).toBe(403);

    const view = await request(app)
      .get('/data/subject/sub-1/requests')
      .set(auth(viewerKey));
    expect(view.status).toBe(200);

    const auditUnauthenticated = await request(app).get('/audit');
    expect(auditUnauthenticated.status).toBe(401);

    const audit = await request(app).get('/audit').set(auth(viewerKey));
    expect(audit.status).toBe(200);

    const auditLog = fs.readFileSync(auditPath, 'utf8');
    expect(auditLog).toContain('"eventType":"data.subject_access"');
    expect(auditLog).toContain('"eventType":"data.audit_access"');
  });

  it('records status transitions with an auditable history', async () => {
    const created = await request(app)
      .post('/data/subject/sub-2/requests')
      .set(auth(operatorKey))
      .send({ requestType: 'erasure' });
    const requestId = created.body.data.request.id as string;

    const processing = await request(app)
      .patch(`/data/subject/sub-2/requests/${requestId}`)
      .set(auth(operatorKey))
      .send({ status: 'processing', note: 'verifying identity' });
    expect(processing.status).toBe(200);
    expect(processing.body.data.request.status).toBe('processing');

    const fulfilled = await request(app)
      .patch(`/data/subject/sub-2/requests/${requestId}`)
      .set(auth(operatorKey))
      .send({ status: 'fulfilled' });
    expect(fulfilled.status).toBe(200);

    const history = fulfilled.body.data.request.history;
    expect(history).toHaveLength(3);
    expect(history[1]).toMatchObject({ from: 'received', to: 'processing', note: 'verifying identity' });
    expect(history[2]).toMatchObject({ from: 'processing', to: 'fulfilled' });
    expect(fulfilled.body.data.request.fulfilledAt).toBeTruthy();

    const invalid = await request(app)
      .patch(`/data/subject/sub-2/requests/${requestId}`)
      .set(auth(operatorKey))
      .send({ status: 'processing' });
    expect(invalid.status).toBe(409);

    const badStatus = await request(app)
      .patch(`/data/subject/sub-2/requests/${requestId}`)
      .set(auth(operatorKey))
      .send({ status: 'nonsense' });
    expect(badStatus.status).toBe(400);

    const wrongSubject = await request(app)
      .patch(`/data/subject/other-subject/requests/${requestId}`)
      .set(auth(operatorKey))
      .send({ status: 'processing' });
    expect(wrongSubject.status).toBe(404);

    const auditLog = fs.readFileSync(auditPath, 'utf8');
    expect(auditLog).toContain('"eventType":"data.subject_request.transition"');
  });

  it('enforces retention boundaries: strictly older records archived, boundary and newer kept', async () => {
    const now = new Date('2026-09-29T12:00:00.000Z');
    const dayMs = 24 * 60 * 60 * 1000;
    const boundaryMs = now.getTime() - 1095 * dayMs;

    const line = (marker: string, tsMs: number) =>
      `${JSON.stringify({ timestampNs: (BigInt(tsMs) * 1_000_000n).toString(), marker })}\n`;
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      auditPath,
      line('newer', boundaryMs + 1) + line('exact-boundary', boundaryMs) + line('older', boundaryMs - 1),
    );

    const agedLog = path.join(logDir, 'aged-debug.log');
    const freshLog = path.join(logDir, 'fresh-debug.log');
    const protectedLog = path.join(logDir, 'audit.log');
    fs.writeFileSync(agedLog, 'old');
    fs.writeFileSync(freshLog, 'new');
    fs.writeFileSync(protectedLog, 'old but protected');
    const agedTime = new Date(now.getTime() - 91 * dayMs);
    fs.utimesSync(agedLog, agedTime, agedTime);
    fs.utimesSync(protectedLog, agedTime, agedTime);

    const result = await enforceRetention(now);

    const auditResult = result.policies.find((p) => p.dataType === 'audit_logs')!;
    expect(auditResult.enforcement).toBe('automatic');
    expect(auditResult.processed).toBe(1);
    expect(auditResult.archivedTo).toBe(path.join(logDir, 'compliance-audit-archive.jsonl'));

    const remaining = fs.readFileSync(auditPath, 'utf8');
    expect(remaining).toContain('newer');
    expect(remaining).toContain('exact-boundary');
    expect(remaining).not.toContain('older');
    expect(fs.readFileSync(archivePath, 'utf8')).toContain('older');

    const debugResult = result.policies.find((p) => p.dataType === 'debug_logs')!;
    expect(debugResult.enforcement).toBe('automatic');
    expect(debugResult.processed).toBe(1);
    expect(fs.existsSync(agedLog)).toBe(false);
    expect(fs.existsSync(freshLog)).toBe(true);
    expect(fs.existsSync(protectedLog)).toBe(true);

    for (const external of ['price_data', 'raw_source_payloads']) {
      const policy = result.policies.find((p) => p.dataType === external)!;
      expect(policy.enforcement).toBe('external');
      expect(policy.skipped).toBe(true);
      expect(policy.reason).toContain('documented policy');
    }
  });

  it('reports SOC 2 controls labelled automated or manual, with recorded results for automated ones', async () => {
    const res = await request(app).get('/compliance/reports/soc2');
    expect(res.status).toBe(200);

    const controls = res.body.data.report.controls as Array<Record<string, unknown>>;
    expect(controls).toHaveLength(7);
    expect(res.body.data.report.controlsByVerification).toEqual({ automated: 3, manual: 4 });

    for (const control of controls) {
      expect(['automated', 'manual']).toContain(control.verification);
      if (control.verification === 'automated') {
        expect(control.lastCheckedAt, String(control.id)).toBeTruthy();
        expect(control.lastResult, String(control.id)).toMatchObject({
          status: expect.stringMatching(/implemented|partial|gap/),
          evidence: expect.any(Array),
        });
      }
    }

    const cc61 = controls.find((c) => c.id === 'CC6.1')!;
    expect(cc61.verification).toBe('automated');
    expect(cc61.lastResult!.status).toBe('implemented');

    const cc72 = controls.find((c) => c.id === 'CC7.2')!;
    expect(cc72.verification).toBe('automated');
    expect(cc72.lastResult!.evidence).toContain('scripts/check-audit-findings.js');

    const cc81 = controls.find((c) => c.id === 'CC8.1')!;
    expect(cc81.verification).toBe('automated');

    const cc74 = controls.find((c) => c.id === 'CC7.4')!;
    expect(cc74.verification).toBe('manual');
    expect(cc74.lastCheckedAt).toBeUndefined();

    const gdpr = await request(app).get('/compliance/reports/gdpr');
    const policies = gdpr.body.data.report.retentionPolicies as Array<Record<string, unknown>>;
    expect(policies.every((p) => ['automatic', 'external'].includes(String(p.enforcement)))).toBe(true);
    expect(policies.find((p) => p.dataType === 'audit_logs')!.enforcement).toBe('automatic');
    expect(policies.find((p) => p.dataType === 'price_data')!.enforcement).toBe('external');

    const dashboard = await request(app).get('/compliance/dashboard');
    expect(dashboard.body.data.soc2ControlsByVerification).toEqual({ automated: 3, manual: 4 });
    expect(dashboard.body.data.soc2AutomatedPassing).toBeGreaterThanOrEqual(2);
  });

  it('survives a restart: state is rebuilt from the store, including records written by other replicas', async () => {
    const created = await request(app)
      .post('/data/subject/sub-3/requests')
      .set(auth(operatorKey))
      .send({ requestType: 'access' });
    const requestId = created.body.data.request.id as string;

    const current = JSON.parse(fs.readFileSync(dsarPath, 'utf8')) as Array<Record<string, unknown>>;
    const replicaWritten = {
      id: 'external-replica-request',
      subjectId: 'sub-3',
      requestType: 'erasure',
      status: 'received',
      owner: 'replica2x',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stores: [],
      history: [],
    };
    fs.writeFileSync(dsarPath, JSON.stringify([...current, replicaWritten], null, 2));

    // Exactly what a fresh process does at startup: a new store binding plus
    // hydrateDsars() rebuilds the in-memory state purely from durable storage.
    setDsarStore(new FileDsarStore(dsarPath));
    await hydrateDsars();

    const listed = await request(app)
      .get('/data/subject/sub-3/requests')
      .set(auth(operatorKey));

    expect(listed.status).toBe(200);
    expect(listed.body.data.count).toBe(2);
    const ids = (listed.body.data.requests as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(requestId);
    expect(ids).toContain('external-replica-request');
    const own = (listed.body.data.requests as Array<{ id: string; owner: string }>).find((r) => r.id === requestId)!;
    expect(own.owner).toBe(operatorKey.substring(0, 8));
  });
});
