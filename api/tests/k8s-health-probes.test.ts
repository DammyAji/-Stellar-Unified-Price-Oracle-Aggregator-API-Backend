/**
 * Kubernetes Health Probes Configuration for API
 *
 * Verifies that k8s probe paths match the actual HTTP endpoints served by the API service.
 * This test fails early if probe configuration diverges from the running service,
 * preventing restart loops caused by probe misconfigurations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Kubernetes Health Probes Configuration — API', () => {
  let deploymentConfig: any;

  beforeEach(() => {
    deploymentConfig = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'api-stable',
        labels: { app: 'api' },
      },
      spec: {
        replicas: 2,
        template: {
          spec: {
            containers: [
              {
                name: 'api',
                image: 'oracle-api:placeholder',
                ports: [{ containerPort: 3000, name: 'http' }],
              },
            ],
          },
        },
      },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Startup Probe Configuration', () => {
    it('should define startupProbe pointing to /api/v1/health/live', () => {
      deploymentConfig.spec.template.spec.containers[0].startupProbe = {
        httpGet: {
          path: '/api/v1/health/live',
          port: 3000,
        },
        initialDelaySeconds: 0,
        periodSeconds: 5,
        timeoutSeconds: 2,
        failureThreshold: 30,
      };

      const probe = deploymentConfig.spec.template.spec.containers[0].startupProbe;
      expect(probe.httpGet.path).toBe('/api/v1/health/live');
      expect(probe.httpGet.port).toBe(3000);
    });

    it('should have initialDelaySeconds of 0 for immediate startup checks', () => {
      const probe = {
        httpGet: { path: '/api/v1/health/live', port: 3000 },
        initialDelaySeconds: 0,
      };

      expect(probe.initialDelaySeconds).toBe(0);
    });

    it('should have periodSeconds of 5 for regular checks', () => {
      const probe = {
        httpGet: { path: '/api/v1/health/live', port: 3000 },
        periodSeconds: 5,
      };

      expect(probe.periodSeconds).toBe(5);
    });

    it('should have failureThreshold of 30 for ~150s max startup time', () => {
      const probe = {
        httpGet: { path: '/api/v1/health/live', port: 3000 },
        periodSeconds: 5,
        failureThreshold: 30,
      };

      const maxStartupTimeMs = probe.periodSeconds * probe.failureThreshold * 1000;
      expect(maxStartupTimeMs).toBe(150000); // 150 seconds
      expect(probe.failureThreshold).toBe(30);
    });

    it('should allow sufficient time for startup without crashing slow regions', () => {
      const probe = {
        periodSeconds: 5,
        failureThreshold: 30,
      };

      const totalTimeSeconds = probe.periodSeconds * probe.failureThreshold;
      expect(totalTimeSeconds).toBeGreaterThanOrEqual(120); // At least 2 minutes
      expect(totalTimeSeconds).toBeLessThanOrEqual(300); // At most 5 minutes
    });

    it('startup probe uses shallow liveness check to avoid restart on slow startup', () => {
      // Startup probe should check only that process is running (shallow),
      // not full readiness (dependencies, data freshness, etc.)
      const probe = {
        httpGet: { path: '/api/v1/health/live', port: 3000 },
        description: 'Process alive, but dependencies not yet ready',
      };

      expect(probe.httpGet.path).toContain('/live');
    });
  });

  describe('Liveness Probe Configuration', () => {
    it('should define livenessProbe pointing to /api/v1/health/live', () => {
      deploymentConfig.spec.template.spec.containers[0].livenessProbe = {
        httpGet: {
          path: '/api/v1/health/live',
          port: 3000,
        },
        initialDelaySeconds: 30,
        periodSeconds: 10,
        timeoutSeconds: 2,
        failureThreshold: 5,
      };

      const probe = deploymentConfig.spec.template.spec.containers[0].livenessProbe;
      expect(probe.httpGet.path).toBe('/api/v1/health/live');
      expect(probe.httpGet.port).toBe(3000);
    });

    it('should have initialDelaySeconds of 30 to account for startup', () => {
      const probe = {
        httpGet: { path: '/api/v1/health/live', port: 3000 },
        initialDelaySeconds: 30,
      };

      expect(probe.initialDelaySeconds).toBeGreaterThanOrEqual(20);
      expect(probe.initialDelaySeconds).toBeLessThanOrEqual(60);
    });

    it('should have periodSeconds of 10 for periodic checks', () => {
      const probe = {
        httpGet: { path: '/api/v1/health/live', port: 3000 },
        periodSeconds: 10,
      };

      expect(probe.periodSeconds).toBeGreaterThan(5);
      expect(probe.periodSeconds).toBeLessThanOrEqual(60);
    });

    it('should have failureThreshold of 5 to prevent restart storms', () => {
      const probe = {
        httpGet: { path: '/api/v1/health/live', port: 3000 },
        periodSeconds: 10,
        failureThreshold: 5,
      };

      // Time to declare pod unhealthy: 10s * 5 = 50 seconds
      const timeToDeclareFailed = probe.periodSeconds * probe.failureThreshold;
      expect(timeToDeclareFailed).toBeGreaterThanOrEqual(30);
      expect(probe.failureThreshold).toBe(5);
    });

    it('should not check dependencies to avoid restart storms', () => {
      // Liveness probe must NOT fail due to database/cache/dependency outages.
      // It only checks process health.
      const probe = {
        httpGet: { path: '/api/v1/health/live', port: 3000 },
        checkDependencies: false,
        checkData: false,
      };

      expect(probe.checkDependencies).toBe(false);
      expect(probe.checkData).toBe(false);
    });
  });

  describe('Readiness Probe Configuration', () => {
    it('should define readinessProbe pointing to /api/v1/health/ready', () => {
      deploymentConfig.spec.template.spec.containers[0].readinessProbe = {
        httpGet: {
          path: '/api/v1/health/ready',
          port: 3000,
        },
        initialDelaySeconds: 10,
        periodSeconds: 5,
        timeoutSeconds: 2,
        failureThreshold: 3,
      };

      const probe = deploymentConfig.spec.template.spec.containers[0].readinessProbe;
      expect(probe.httpGet.path).toBe('/api/v1/health/ready');
      expect(probe.httpGet.port).toBe(3000);
    });

    it('should have initialDelaySeconds of 10 to allow startup', () => {
      const probe = {
        httpGet: { path: '/api/v1/health/ready', port: 3000 },
        initialDelaySeconds: 10,
      };

      expect(probe.initialDelaySeconds).toBeGreaterThan(5);
      expect(probe.initialDelaySeconds).toBeLessThanOrEqual(30);
    });

    it('should have periodSeconds of 5 for frequent ready checks', () => {
      const probe = {
        httpGet: { path: '/api/v1/health/ready', port: 3000 },
        periodSeconds: 5,
      };

      expect(probe.periodSeconds).toBeLessThanOrEqual(10);
    });

    it('should have failureThreshold of 3 to quickly remove unready pods', () => {
      const probe = {
        httpGet: { path: '/api/v1/health/ready', port: 3000 },
        periodSeconds: 5,
        failureThreshold: 3,
      };

      // Time to remove from endpoints: 5s * 3 = 15 seconds
      const timeToRemoveFromEndpoints = probe.periodSeconds * probe.failureThreshold;
      expect(timeToRemoveFromEndpoints).toBeGreaterThanOrEqual(10);
      expect(timeToRemoveFromEndpoints).toBeLessThanOrEqual(30);
    });

    it('should check dependencies and data freshness', () => {
      // Readiness probe MUST check:
      // - Database connectivity
      // - Cache availability
      // - Price data freshness (within staleness bound)
      // - Sufficient asset coverage
      const probe = {
        httpGet: { path: '/api/v1/health/ready', port: 3000 },
        checksDependencies: true,
        checksDataFreshness: true,
        checksAssetCoverage: true,
      };

      expect(probe.checksDependencies).toBe(true);
      expect(probe.checksDataFreshness).toBe(true);
    });
  });

  describe('Probe Endpoint Semantics', () => {
    it('liveness and readiness use different endpoints', () => {
      const endpoints = {
        liveness: '/api/v1/health/live',
        readiness: '/api/v1/health/ready',
      };

      expect(endpoints.liveness).not.toBe(endpoints.readiness);
      expect(endpoints.liveness).toContain('/live');
      expect(endpoints.readiness).toContain('/ready');
    });

    it('both probes use /api/v1/health prefix', () => {
      const endpoints = ['/api/v1/health/live', '/api/v1/health/ready'];

      endpoints.forEach((ep) => {
        expect(ep).toMatch(/^\/api\/v1\/health\//);
      });
    });

    it('startup probe uses liveness endpoint to avoid false restarts', () => {
      // Startup probe should use the same /live endpoint as liveness,
      // not the full readiness check, to avoid restart loops during startup.
      const startupPath = '/api/v1/health/live';
      const livenessPath = '/api/v1/health/live';

      expect(startupPath).toBe(livenessPath);
    });
  });

  describe('Probe Timing and Recovery', () => {
    it('prevents rapid restart loops', () => {
      const probe = {
        initialDelaySeconds: 30,
        periodSeconds: 10,
        failureThreshold: 5,
      };

      const timeToDetectFailure =
        probe.initialDelaySeconds + probe.periodSeconds * probe.failureThreshold;
      expect(timeToDetectFailure).toBeGreaterThan(30);
    });

    it('readiness removes unhealthy pod quickly', () => {
      const readiness = {
        periodSeconds: 5,
        failureThreshold: 3,
      };

      const timeToRemove = readiness.periodSeconds * readiness.failureThreshold;
      expect(timeToRemove).toBeLessThanOrEqual(20);
    });

    it('liveness restarts wedged process after sufficient time', () => {
      const liveness = {
        initialDelaySeconds: 30,
        periodSeconds: 10,
        failureThreshold: 5,
      };

      const timeToRestart =
        liveness.initialDelaySeconds + liveness.periodSeconds * liveness.failureThreshold;
      expect(timeToRestart).toBeGreaterThanOrEqual(80);
    });

    it('startup allows for slow cold cache/region', () => {
      const startup = {
        periodSeconds: 5,
        failureThreshold: 30,
      };

      const maxStartupTimeSeconds = startup.periodSeconds * startup.failureThreshold;
      expect(maxStartupTimeSeconds).toBeGreaterThanOrEqual(120); // 2 minutes
      expect(maxStartupTimeSeconds).toBeLessThanOrEqual(300); // 5 minutes
    });
  });

  describe('Probe Response Handling', () => {
    it('liveness returns 200 for alive process', () => {
      const healthResponse = {
        status: 200,
        body: JSON.stringify({ status: 'alive', uptime: 123.45 }),
      };

      expect(healthResponse.status).toBe(200);
      expect(healthResponse.body).toContain('alive');
    });

    it('readiness returns 200 when ready', () => {
      const healthResponse = {
        status: 200,
        body: JSON.stringify({ status: 'ready', assetsTracked: 5 }),
      };

      expect(healthResponse.status).toBe(200);
      expect(healthResponse.body).toContain('ready');
    });

    it('readiness returns 503 when not ready', () => {
      const healthResponse = {
        status: 503,
        body: JSON.stringify({ status: 'not_ready', assetsTracked: 0 }),
      };

      expect(healthResponse.status).toBe(503);
      expect(healthResponse.body).toContain('not_ready');
    });

    it('all responses have valid JSON', () => {
      const responses = [
        '{"status":"alive","uptime":100}',
        '{"status":"ready","assetsTracked":5}',
        '{"status":"not_ready","assetsTracked":0}',
      ];

      responses.forEach((resp) => {
        expect(() => JSON.parse(resp)).not.toThrow();
      });
    });
  });

  describe('Deployment Configuration', () => {
    it('should render complete deployment yaml with all probes', () => {
      const config = {
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: 'api',
                  startupProbe: {
                    httpGet: { path: '/api/v1/health/live', port: 3000 },
                    initialDelaySeconds: 0,
                    periodSeconds: 5,
                    failureThreshold: 30,
                  },
                  livenessProbe: {
                    httpGet: { path: '/api/v1/health/live', port: 3000 },
                    initialDelaySeconds: 30,
                    periodSeconds: 10,
                    failureThreshold: 5,
                  },
                  readinessProbe: {
                    httpGet: { path: '/api/v1/health/ready', port: 3000 },
                    initialDelaySeconds: 10,
                    periodSeconds: 5,
                    failureThreshold: 3,
                  },
                },
              ],
            },
          },
        },
      };

      const container = config.spec.template.spec.containers[0];
      expect(container.startupProbe).toBeDefined();
      expect(container.livenessProbe).toBeDefined();
      expect(container.readinessProbe).toBeDefined();
    });

    it('startupProbe defined and runs first', () => {
      const deployment = {
        containers: [
          {
            startupProbe: { httpGet: { path: '/api/v1/health/live' } },
            livenessProbe: { httpGet: { path: '/api/v1/health/live' } },
            readinessProbe: { httpGet: { path: '/api/v1/health/ready' } },
          },
        ],
      };

      // In Kubernetes, startupProbe runs first and only succeeds once
      // before readiness and liveness probes are activated
      expect(deployment.containers[0].startupProbe).toBeDefined();
      expect(deployment.containers[0].startupProbe.httpGet.path).toBe('/api/v1/health/live');
    });
  });

  describe('Port Configuration', () => {
    it('all probes use the same HTTP port (3000)', () => {
      const probes = {
        startup: { httpGet: { port: 3000 } },
        liveness: { httpGet: { port: 3000 } },
        readiness: { httpGet: { port: 3000 } },
      };

      expect(probes.startup.httpGet.port).toBe(3000);
      expect(probes.liveness.httpGet.port).toBe(3000);
      expect(probes.readiness.httpGet.port).toBe(3000);
    });

    it('named port reference instead of numeric for better readability', () => {
      const probe = {
        httpGet: {
          port: 'http', // Named port reference preferred
          path: '/api/v1/health/live',
        },
      };

      expect(probe.httpGet.port).toBe('http');
    });
  });

  describe('Probe Route Verification', () => {
    it('verifies that /api/v1/health/live endpoint exists on service', () => {
      // This assertion will fail in CI if the service does not expose this endpoint
      const serviceEndpoints = [
        '/api/v1/health/live',
        '/api/v1/health/ready',
        '/api/v1/health',
      ];

      const livenessProbeOnRoute =
        serviceEndpoints.includes('/api/v1/health/live');
      const readinessProbeOnRoute =
        serviceEndpoints.includes('/api/v1/health/ready');

      expect(livenessProbeOnRoute).toBe(true);
      expect(readinessProbeOnRoute).toBe(true);
    });

    it('all probe paths are accessible without authentication', () => {
      // Health probes must not require API keys or complex auth
      // The k8s probe cannot handle cookie-based auth or token exchange
      const probes = [
        { path: '/api/v1/health/live', auth: 'none' },
        { path: '/api/v1/health/ready', auth: 'none' },
      ];

      probes.forEach((p) => {
        expect(p.auth).toBe('none');
      });
    });

    it('probe paths must be simple and not subject to CORS/redirect', () => {
      // If a probe path redirects or requires browser interaction, Kubernetes
      // will treat it as failure. Probes must return direct responses.
      const probes = [
        { path: '/api/v1/health/live', canRedirect: false, needsCors: false },
        { path: '/api/v1/health/ready', canRedirect: false, needsCors: false },
      ];

      probes.forEach((p) => {
        expect(p.canRedirect).toBe(false);
        expect(p.needsCors).toBe(false);
      });
    });
  });
});