# Audit log retention and tamper evidence

This policy defines how operational audit logs are retained and verified.

## Retention policy

The default operational policy is 90 days in active storage; the compliance
dashboard keeps a longer archive window for supporting evidence and
subject-access workflows.

- audit logs: 90 days in active storage, then archived
- archive retention: 3 years for governance and incident evidence
- debug and raw payload logs: 90 days, then deletion

Configure the window with `AUDIT_RETENTION_DAYS` (default `90`). A value of
`0` disables archiving entirely.

### Retention is archived, not deleted

Entries older than the retention window are **moved, never dropped**:

- `logs/audit.log` holds the active tail of the chain and is append-only on
  the request path.
- `logs/audit-archive/audit-YYYY-MM-DD.jsonl` holds every entry aged out on
  that UTC date. Archive files are only ever appended to, so an entry that has
  been archived once is never written twice: the sweep re-reads the target
  file and appends only lines it does not already contain.

The decision to archive rather than delete is what makes the archive window
(evidence kept for 3 years) enforceable from the same code path as the active
window (90 days) — retention shrinks `audit.log` without destroying the
record.

## How retention runs (issue #599)

Retention is **never** part of the request path. `auditLog()` performs a
single synchronous append and nothing else; it does not read, rewrite or
rename the file.

A scheduler (`startAuditRetentionScheduler()`, started by `api/src/index.ts`)
runs `enforceAuditRetention()`:

- every `AUDIT_RETENTION_SWEEP_MS` milliseconds (default 1 hour), plus once
  shortly after startup;
- under an exclusive lock file `logs/.audit-retention.lock` (`wx` create, stale
  after 10 minutes), so two processes cannot rewrite the log concurrently;
- aged entries are archived first (append-only, idempotent), then the active
  log is replaced through a temp file + `rename`, so a crash at any point
  leaves the original file intact and parseable;
- the replace is retried up to three times if another writer touched the
  active log while the sweep was running, and is skipped (not forced) if the
  log keeps changing;
- the result is read back and every line parsed before the sweep counts as
  successful.

Failures are surfaced, never swallowed: a failed sweep increments
`audit_retention_failures_total{reason}` and logs
`Audit retention could not run` with `alert: 'audit-retention'`, which the
`AuditRetentionFailing` Prometheus rule pages on. `enforceAuditRetention()`
returns `{ status, total, kept, archived, error }` so callers can inspect the
outcome as well.

### Measured write-path cost

Because `auditLog()` is now a single append, per-event cost no longer grows
with the size of `logs/audit.log`; previously each event re-read, re-parsed
and rewrote the whole file. `audit_log_append_duration_seconds` records the
per-event cost, and `tests/governance/audit-retention.test.ts` asserts that a
write performs no read/rename and stays fast against a 20,000-entry log.

## Tamper-evident chain

Each audit entry includes a SHA-256 HMAC computed over the payload and the
previous entry's hash. This produces a chained record that can be checked in
order to detect tampering or log truncation.

The chain spans the archive and the active log, so verification has to read
both. `readAuditChain()` concatenates every `logs/audit-archive/*.jsonl`
(in date order) followed by `logs/audit.log`, and
`verifyAuditLogChain(entries, startHead)` walks the result. `startHead` is the
`prevHmac` of the first entry in a slice when you are not starting from the
very beginning of the chain.

## Verification workflow

1. Export `logs/audit-archive/*.jsonl` plus `logs/audit.log` (or call
   `readAuditChain()`).
2. Recompute the HMAC chain in order, seeding `startHead` from the first
   entry when verifying a slice.
3. Compare each computed hash against the stored `hmac` value.
4. Treat the first mismatch as a tamper indicator and quarantine the file for
   forensic review.

This workflow can be used to satisfy audit and incident-review requirements
without introducing a new operational dependency on an external attestation
service.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AUDIT_RETENTION_DAYS` | `90` | Age after which an entry leaves the active log. `0` disables retention. |
| `AUDIT_RETENTION_SWEEP_MS` | `3600000` | Interval between scheduled sweeps. |
| `AUDIT_LOG_DIR` | `logs` | Directory holding `audit.log`, `audit-archive/` and the retention lock. |
| `AUDIT_SECRET` | built-in default | HMAC key for the tamper-evident chain; must be set in production. |
