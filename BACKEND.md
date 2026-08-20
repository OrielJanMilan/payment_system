# Backend Architecture

Design document only — nothing here is implemented yet. This records the backend
decisions for realizing the driver app (see [SCREEN_FUNCTIONALITY.md](SCREEN_FUNCTIONALITY.md))
and the system blueprint (published design doc). Status: **proposed, for review**.

---

## 1. Shape: modular monolith

One deployable application with strict internal module boundaries — not microservices.

**Why:** a small team building a payments MVP. The critical sequence
*session ended → capture payment → write ledger entries* becomes **one Postgres
transaction** in a monolith; across services it becomes a distributed saga with
compensation logic — complexity in exactly the place that handles money.

Rules that keep the monolith honest:

- Module boundaries mirror the blueprint: `sessions`, `payments`, `chargers`,
  `ledger`, `receipts`, `webhooks`.
- The `payments` module is the only code that imports provider adapters
  (`providers/maya/`); nothing else may reference Maya types or endpoints.
- The `ledger` module exposes append-only, balanced writes; no other module
  writes money rows directly.
- Any module can be split into its own service later without changing the
  provider seam or the ledger design.

## 2. The charger question (biggest scope decision)

BTC Power very likely already operates a CSMS / network management system holding
the OCPP connections to chargers. Two paths:

| Path | What we build | When |
|---|---|---|
| **A — integrate (preferred)** | A `chargers` module that calls the existing CSMS API: remote start/stop, meter values via webhook or polling | If the CSMS exposes (or can expose) these APIs |
| **B — own the sockets** | A separate charger-gateway process speaking OCPP 1.6J/2.0.1 over WebSocket | Only if no usable CSMS API exists |

Path A shrinks this whole system to "API + payments + ledger". **Confirm which path
applies before any implementation starts** (blueprint open question #4).

The full data contract either way — OCPP messages, CSMS API/event requirements,
kWh accuracy rules, timeouts, and reconciliation — is specced in one place:
[Charging_Synchronization.md](Charging_Synchronization.md). This file intentionally
does not repeat it.

## 3. Stack

**Recommended: Node.js + TypeScript (NestJS) · PostgreSQL · Redis · BullMQ**

| Piece | Choice | Why |
|---|---|---|
| Runtime / framework | Node 22 + TypeScript, NestJS | One language with the PWA; SSE/WebSockets first-class; Maya's REST + webhooks trivial from Node; NestJS modules map 1:1 to the boundaries above |
| Database | PostgreSQL 16 | Real transactions and constraints for the double-entry ledger, `provider_events` audit, idempotency keys, BIR receipt sequences |
| Cache / pub-sub | Redis | Fan-out of meter values to SSE connections (any API instance can serve any driver's live screen) |
| Job queue | BullMQ (on Redis) | Webhook processing, capture retries with backoff, hold voids. The blueprint's "capture failed → manual review, never silently dropped" = a dead-letter queue with an alert |
| ORM | Drizzle or Prisma for ordinary tables; **raw SQL in explicit transactions for ledger writes** | The balancing constraint should be visible, not hidden behind an ORM |

Acceptable alternatives, driven by team fluency rather than framework merits:
**Go** (especially if we own raw OCPP — path B), **C#/.NET** or **Java/Spring**
(if that's the existing backend competency at BTC Power).

Ruled out: serverless-first (Lambda-per-endpoint). Long-lived SSE connections,
OCPP sockets, and webhook ordering all fight that model; containers fit.

## 4. Intended repo layout (not yet created)

```
payment-system/
├── apps/
│   ├── api/                    # NestJS app — the one deployable
│   │   ├── modules/
│   │   │   ├── sessions/       # session state machine, tariff engine
│   │   │   ├── payments/       # intents, payment state machine, refunds
│   │   │   │   └── providers/  # PaymentProvider interface + registry
│   │   │   │       └── maya/   # the only Maya-aware code
│   │   │   ├── chargers/       # registry mirror + CSMS client (or OCPP gateway)
│   │   │   ├── ledger/         # double-entry writes, raw SQL
│   │   │   ├── receipts/       # BIR numbering, PDF, SMS/email delivery
│   │   │   └── webhooks/       # /webhooks/maya — verify sig, persist raw, enqueue
│   │   └── workers/            # BullMQ processors: capture, retry, void
│   └── web/                    # driver PWA (one implementation of A/B/C)
├── packages/shared/            # DTOs shared by api + web
└── infra/                      # IaC + DB migrations
```

## 5. Platform / hosting

- **Phase 1 pilot (one site):** somewhere boring and fast — Fly.io, Railway, or a
  single ECS service — with managed Postgres + Redis. The pilot proves the Maya
  flow end-to-end, not the infrastructure.
- **Production:** AWS **ap-southeast-1 (Singapore)** — standard region for PH
  workloads, adjacent to Maya's infrastructure.
  - ECS Fargate behind an ALB (SSE works; set long idle timeouts)
  - RDS Postgres Multi-AZ · ElastiCache Redis
  - Secrets Manager for provider credentials (referenced by `provider_config`,
    never stored in the DB)
  - CloudWatch alarms — the paging alert is the **capture dead-letter queue**
    ("a customer's money is in limbo")
- Verify with Maya early: webhook source IPs / any static-IP allow-listing
  requirement — it decides NAT/ingress design and is cheap to know up front.

## 6. How the backend realizes the screens

- Every endpoint in [SCREEN_FUNCTIONALITY.md](SCREEN_FUNCTIONALITY.md) maps onto the
  modules above; no screen in Options A/B/C needs more backend than this.
- Option C's merged **"Hold & start"** = one API call orchestrated in-process by
  `sessions` (create session → checkout via the registry-resolved adapter).
- **Quick Start** = saved provider payment token + the same chained call.
- The live screen = `GET /sessions/{id}/events` (SSE) fed from Redis pub/sub.
- Webhooks: verify signature → persist raw payload (`provider_events`) → enqueue →
  idempotent state-machine transition (`event_id` unique constraint).

## 7. Build order (when implementation starts)

1. **Maya sandbox spike** — throwaway script proving checkout → webhook →
   capture/void. Also answers the auth/capture-split question (blueprint open
   question #1), which decides whether v1 leads with holds or prepay-refund.
2. Skeleton monolith: `payments` module + ledger + webhook ingestion, sandbox-only.
3. `chargers` integration (path A or B per §2) against one pilot charger.
4. Wire the PWA (whichever design option is chosen) to the API.

## 8. Resources needed

Everything external the backend depends on — accounts, APIs, credentials, and
who has to provide them. Items marked **P1** block the Phase 1 pilot.

### Payments — Maya

| Resource | Detail | Needed |
|---|---|---|
| Maya Business account | Merchant onboarding (business registration, bank account for settlement) — longest lead time, start first | **P1** |
| Maya Checkout API — sandbox | Public/secret key pair for the sandbox spike (checkout create, payment status) | **P1** |
| Maya Checkout API — production keys | Issued after onboarding approval; stored in Secrets Manager only | Launch |
| Maya webhook registration | Our `/webhooks/maya` URL registered; webhook signing secret; their source IPs (for allow-listing) | **P1** |
| Maya capability confirmation | Auth/capture split per method, hold validity window, refund API, settlement cadence & fees | **P1** (decides hold vs prepay model) |
| Maya Vault (tokenization) | Saved payment methods — required for Option C Quick Start | Phase 2/3 |

### Chargers — CSMS

| Resource | Detail | Needed |
|---|---|---|
| CSMS API access | Credentials + docs for remote start/stop, status, registry (see [Charging_Synchronization.md](Charging_Synchronization.md) §2) | **P1** |
| CSMS event feed | Webhooks or polling endpoint for started / meter / ended events, with signing secret | **P1** |
| One pilot charger | A real unit (with billing-grade meter) + its QR slug, on a test tariff | **P1** |
| Charger config change | `MeterValueSampleInterval`, `StopTxnSampledData` set fleet-wide | Launch |

### Infrastructure & services

| Resource | Detail | Needed |
|---|---|---|
| Domain + TLS | e.g. `charge.<company>.ph` — this URL is printed in every QR code, so pick it once and early | **P1** |
| Hosting | Pilot: Fly.io/Railway/single ECS. Production: AWS account, ap-southeast-1 (ECS Fargate, ALB, RDS Postgres, ElastiCache Redis, Secrets Manager, CloudWatch) | **P1** / Launch |
| SMS provider | PH-capable sender for OTP + receipts (e.g. Semaphore, M360, or Twilio) — per-message cost feeds the receipts decision | **P1** |
| Email sender | SES or equivalent, with domain authentication (SPF/DKIM) for receipt delivery | **P1** |
| Error/uptime monitoring | Sentry (or similar) + uptime checks + the capture dead-letter alert route (who gets paged) | Launch |
| CI/CD | GitHub Actions (repo is already on GitHub) — build, test, migrate, deploy | **P1** |

### Compliance & business

| Resource | Detail | Needed |
|---|---|---|
| BIR official receipt setup | Receipt series/numbering registration and the format requirements our PDF must satisfy | Launch |
| Tariff sign-off | ₱/kWh per site, idle fee, hold sizing bounds — from the business, not engineering | **P1** |
| Legal/regulatory check | ERC rules on per-kWh resale, e-commerce/consumer disclosure requirements, privacy (NPC registration if applicable) | Launch |
| Pen test / security review | Before production launch (Phase 2 exit) | Launch |

## 9. Open decisions before implementation

| # | Decision | Owner input needed |
|---|---|---|
| 1 | CSMS integration path (A vs B in §2) | Charger platform team |
| 2 | Language/framework confirmation vs team skills | Engineering lead |
| 3 | Maya merchant capabilities: auth/capture split, webhook IPs, settlement cadence | Maya onboarding |
| 4 | Pilot hosting choice | DevOps |
| 5 | Receipt delivery channel costs (SMS vs email) | Product/finance |
