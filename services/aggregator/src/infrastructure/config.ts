import dotenv from 'dotenv';
import path from 'path';
import { decryptSecret } from './crypto';
import { parseConfigEnv, redactConfig } from './config-schema';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function deriveSourceHosts(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    hosts.add(new URL(url).hostname.toLowerCase());
  }
  return Array.from(hosts);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = parseConfigEnv(env);

  const regionId = parsed.REGION_ID ?? parsed.AWS_REGION?.trim() ?? 'local';
  const sourceUrls = [
    parsed.CHAINLINK_BASE_URL,
    parsed.REDSTONE_BASE_URL,
    parsed.BAND_BASE_URL,
    parsed.REFLECTOR_BASE_URL,
  ];

  return {
    port: parsed.PORT,
    pollingIntervalMs: parsed.POLLING_INTERVAL_MS,
    stalenessThresholdMs: parsed.STALENESS_THRESHOLD_MS,

    soroban: {
      rpcUrl: parsed.SOROBAN_RPC_URL,
      contractId: parsed.CONTRACT_ID,
      networkPassphrase: parsed.NETWORK_PASSPHRASE,
      adminSecret: decryptSecret(parsed.ADMIN_SECRET_KEY),
    },

    canary: {
      failureThreshold: parsed.CANARY_FAILURE_THRESHOLD,
      autoRollback: parsed.CANARY_AUTO_ROLLBACK,
    },

    sources: {
      chainlink: {
        baseUrl: parsed.CHAINLINK_BASE_URL,
        apiKey: decryptSecret(parsed.CHAINLINK_API_KEY),
      },
      redstone: { baseUrl: parsed.REDSTONE_BASE_URL },
      band: { baseUrl: parsed.BAND_BASE_URL },
      reflector: { baseUrl: parsed.REFLECTOR_BASE_URL },
    },

    assets: parsed.WATCHED_ASSETS,

    logLevel: parsed.LOG_LEVEL,

    region: {
      id: regionId,
      activeActive: parsed.ACTIVE_ACTIVE_REGIONS_ENABLED,
      peers: parsed.REGION_PEERS.map((peer) => peer.toLowerCase()),
      replicationTopic: parsed.REGION_REPLICATION_TOPIC,
      driftAlertPercent: parsed.REGION_DRIFT_ALERT_PERCENT,
      quarantineEnabled: parsed.REGION_QUARANTINE_ENABLED,
      quarantineRecoverPercent: parsed.REGION_QUARANTINE_RECOVER_PERCENT,
      maxReplicationLagMs: parsed.REGION_MAX_REPLICATION_LAG_MS,
    },

    database: {
      url: decryptSecret(parsed.DATABASE_URL),
      useTimescale: parsed.USE_TIMESCALEDB,
      chunkIntervalSeconds: parsed.TIMESCALE_CHUNK_INTERVAL_SECONDS,
      retentionDays: parsed.HISTORY_RETENTION_DAYS,
    },

    history: {
      maxEntries: parsed.HISTORY_MAX_ENTRIES,
      retentionSeconds: parsed.HISTORY_RETENTION_SECONDS,
      archival: {
        enabled: parsed.FILE_ARCHIVAL_ENABLED,
        archiveAfterDays: parsed.FILE_ARCHIVE_AFTER_DAYS,
        retentionDays: parsed.FILE_RETENTION_DAYS,
        coldStorageDir: parsed.FILE_COLD_STORAGE_DIR,
        intervalMs: parsed.FILE_ARCHIVAL_INTERVAL_MS,
      },
    },

    security: {
      ssrf: {
        enabled: parsed.SSRF_PROTECTION_ENABLED,
        allowedHosts: [...deriveSourceHosts(sourceUrls), ...parsed.ORACLE_ALLOWED_HOSTS],
        allowPrivateIps: parsed.SSRF_ALLOW_PRIVATE_IPS,
        requestTimeoutMs: parsed.OUTBOUND_REQUEST_TIMEOUT_MS,
      },
      websocket: {
        allowedOrigins: parsed.WS_ALLOWED_ORIGINS,
        requireOrigin: parsed.WS_REQUIRE_ORIGIN,
        maxConnectionsPerWindow: parsed.WS_RATE_LIMIT_MAX,
        rateLimitWindowMs: parsed.WS_RATE_LIMIT_WINDOW_MS,
      },
      encryption: {
        key: parsed.ENCRYPTION_KEY,
        previousKey: parsed.ENCRYPTION_KEY_PREVIOUS,
        encryptHistory: parsed.ENCRYPT_HISTORY,
      },
    },

    websocket: {
      maxSubscriptions: parsed.WS_MAX_SUBSCRIPTIONS,
      dropBufferBytes: parsed.WS_BACKPRESSURE_DROP_BYTES,
      pingIntervalMs: parsed.WS_PING_INTERVAL_MS,
      pingTimeoutMs: parsed.WS_PING_TIMEOUT_MS,
      maxClientMessageBytes: parsed.WS_MAX_CLIENT_MESSAGE_BYTES,
    },
  };
}

export type AggregatorConfig = ReturnType<typeof loadConfig>;

export function redactedConfigView(value: AggregatorConfig): unknown {
  return redactConfig(value);
}

function isCheckConfigRequest(): boolean {
  return process.argv.includes('--check-config');
}

function failFast(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function isTestRunner(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

export const config: AggregatorConfig = (() => {
  try {
    const resolved = loadConfig(process.env);
    if (isCheckConfigRequest()) {
      console.log(JSON.stringify(redactedConfigView(resolved), null, 2));
      process.exit(0);
    }
    return resolved;
  } catch (error) {
    if (!isTestRunner()) failFast(error);
    throw error;
  }
})();
