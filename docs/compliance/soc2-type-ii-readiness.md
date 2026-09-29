# SOC 2 Type II readiness and control mapping

This document maps the current oracle service controls to the relevant SOC 2 trust criteria and calls out the near-term gaps we should treat as tracked work items.

## Current control map

| Trust criteria | Current control | Status | Evidence |
| --- | --- | --- | --- |
| CC1.1 | Governance and risk oversight | Partial | repository governance, ADRs, change pipeline |
| CC2.1 | Control environment | Partial | CI workflow, review process, deployment docs |
| CC6.1 | Logical access | Partial | API key manager, RBAC, least-privilege reviews |
| CC6.6 | Transmission security | Partial | TLS enforcement, HSTS headers, secure secret handling |
| CC7.2 | Monitoring | Implemented | Prometheus metrics, uptime tracking, structured logs |
| CC7.4 | Incident response | Partial | runbooks and alerting, but response playbooks need sign-off |
| CC8.1 | Change management | Partial | CI and versioned deployment assets |
| A1.2 | Capacity management | Partial | metrics and scaling docs |
| A1.3 | Backup and recovery | Partial | encrypted backup service and restore procedures |

## Evidence automation

The API already records compliance audit events and writes them to a tamper-linked JSONL log. We should continue to expose this through the compliance reporting endpoints and export them into the evidence repository with a fixed retention window.

Required follow-up actions:
- keep the audit trail append-only and hash-linked
- retain backup evidence and restore-test output
- merge access review and key rotation records into the same evidence feed
- automate quarterly reporting into the security evidence bucket

## Runtime control verification

The controls that the API can prove by itself are executed at report time
(`GET /api/v1/compliance/reports/soc2`, the dashboard, and scheduled reports)
and are labelled per control:

| Control | Verification | What runs | Result recorded |
| --- | --- | --- | --- |
| CC6.1 Logical access | automated | scans `api/src/governance/admin.ts` and verifies every admin route declares `requireRole(minRole, permission)` | `controls[].lastCheckedAt`, `controls[].lastResult` |
| CC7.2 Monitoring | automated | parses `docs/security/audit-findings.md` with the same rules as `scripts/check-audit-findings.js` (open Critical findings ⇒ gap) | `controls[].lastCheckedAt`, `controls[].lastResult` |
| CC8.1 Change management | automated | verifies `.github/workflows/ci.yml` exists | `controls[].lastCheckedAt`, `controls[].lastResult` |
| CC6.6, CC7.4, A1.2, A1.3 | manual | none — labelled `verification: "manual"` so reports never present them as checked | `controls[].verification` |

Every report also carries `controlsByVerification` (automated vs manual
counts) so a reviewer can see which assertions come from a check and which
require sign-off. Retention policies are labelled the same way: `audit_logs`
and `debug_logs` are `enforcement: "automatic"` (executed by the daily
enforcement pass in `api/src/governance/compliance.ts`), while `price_data`
and `raw_source_payloads` are `enforcement: "external"` and explicitly
reported as documented-but-not-executed-here.

## Gaps to track

- finalise a formal incident response playbook with escalation ownership
- confirm backup restore testing cadence and evidence retention
- complete formal access review approvals for production roles
- document a production change approval gate and emergency rollback evidence

This is the current posture only; the control set should be treated as the minimum evidence baseline for a SOC 2 Type II audit readiness review.
