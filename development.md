# Development Progress

**Overall completion: 49 / 80 — 61%**
`████████████░░░░░░░░` Stage 1: 49/49 (100%) · Stage 2: 0/31 (0%)

*(Recount when flipping items: `grep -c '^- ✅' development.md` vs `'^- ❌'`.)*

Step-by-step tracker, organized in stages:

- **Stage 1 — Mock end-to-end (✅ COMPLETE, tagged `milestone-mock-e2e`)**: full
  flow tested on a phone with a mock Maya and a mock OCPP charger — no real
  payment, no real charger link.
- **Stage 2 — Real integrations & launch path (in planning)**: real Maya
  sandbox, real CSMS/OCPP link, hardening, pilot deployment, launch readiness.

Legend: ✅ done · ❌ not done. Work top-to-bottom; each phase builds on the one
above it. When a step is completed, verified, and reviewed, flip its ❌ to ✅.

References: [BACKEND.md](BACKEND.md) · [SCREEN_FUNCTIONALITY.md](SCREEN_FUNCTIONALITY.md) ·
[Charging_Synchronization.md](Charging_Synchronization.md)

---

## STAGE 1 — Mock end-to-end ✅ COMPLETE

All phases done and verified; tagged `milestone-mock-e2e` (Aug 21, 2026).

### Phase 0 — Design basepoint

- ✅ Screen & element functional spec (`SCREEN_FUNCTIONALITY.md`)
- ✅ Backend architecture design (`BACKEND.md`)
- ✅ Charging synchronization / OCPP data contract (`Charging_Synchronization.md`)
- ✅ Design mockups — Options A, B, C (`design/`)
- ✅ Option C UI prototype, client-side simulated (`ui/` — all API calls are `TODO(api)` stubs)

### Phase 1 — Project scaffolding

- ✅ 1.1 `git init` the repo; add `.gitignore`, first commit of the basepoint
- ✅ 1.2 Repo layout per BACKEND.md §4: `apps/api/` (backend), `apps/web/` (moved from `ui/`), `packages/shared/` (DTOs)
- ✅ 1.3 Backend skeleton — Node + TypeScript + Express (module boundaries as folders; framework-agnostic core), config loading, `GET /health`
- ✅ 1.4 Dev database — SQLite via built-in `node:sqlite`, migration runner (`PRAGMA user_version`), tables: `chargers`, `connectors`, `sessions`, `payment_intents`, `provider_events`
- ✅ 1.5 Seed data — one virtual site + charger `CHG-0042` (CCS2, 60 kW, ₱48.50/kWh tariff, ₱1,500 hold) + `qr_slug` `chg-0042-a1b2`
- ✅ 1.6 Static serving of the PWA from the API process (one origin — no CORS, one URL for the phone)
- ✅ 1.7 `.claude/launch.json` dev-server entry (`app` → `npm run dev`, port 3000)

### Phase 2 — Sessions module + charger registry (API surface the UI needs)

- ✅ 2.1 `GET /chargers/{code}` — charger lookup by printed code (case-insensitive) with connector status; 404 on unknown
- ✅ 2.2 `GET /c/{qr_slug}` deep-link route — resolves slug, redirects to the app shell (`/?c={slug}`; invalid → `/?error=charger-not-found` for the S1 error state); plus `GET /chargers/by-slug/{slug}` for the client's data load
- ✅ 2.3 `POST /sessions` — creates session in `pending_payment`, pins the tariff, computes the hold server-side, atomically claims the connector (409 when unavailable); 10-min TTL
- ✅ 2.4 Session state machine (`modules/sessions/service.ts`) — guarded idempotent transitions incl. `expired` (lazy on read + 30 s sweep) and `start_failed`; connector released on terminal states; 23-check smoke test (`npm run smoke`)
- ✅ 2.5 `GET /sessions/{id}` — session detail (state, pinned tariff/hold, meter + billing fields)
- ✅ 2.6 `GET /sessions/{id}/events` — SSE stream: initial state snapshot, published state/meter events, 15 s heartbeats

### Phase 3 — Mock Maya payment provider

- ✅ 3.1 `PaymentProvider` interface + registry (`modules/payments/providers/provider.ts`) — only `providers/` code knows provider types
- ✅ 3.2 Payment intent state machine — guarded idempotent transitions: `CREATED → PENDING_AUTH → AUTHORIZED → CAPTURING → CAPTURED` + `AUTH_FAILED / EXPIRED / VOIDED / REFUNDED`
- ✅ 3.3 `MockMaya` adapter — `createCheckout` → local hosted-page redirect URL; `capture` (never above the hold), `voidHold`, `refund` against in-memory checkout state
- ✅ 3.4 Mock hosted-checkout page (`/mock-maya/checkout/{id}`) — amount + method, **Authorize / Fail / Expire** buttons, 410 once used, redirects back to `/?payment_return={intentId}`
- ✅ 3.5 Mock webhook flow — HMAC-signed delivery over real HTTP to `POST /webhooks/maya`; signature verified (timing-safe), raw payload persisted to `provider_events`, unique `event_id` makes replays recorded no-ops
- ✅ 3.6 `POST /payments/checkout` — intent + checkout via the registry-resolved adapter; 409 when the session isn't payable
- ✅ 3.7 `GET /payments/{id}` polling endpoint for the return-from-checkout wait
- ✅ 3.8 `captureForSession` (exact metered amount + mock OR number) and `voidForSession` — wired to charger events in Phase 4; `paymentsBus` emits `authorized/captured/voided` for the charger gateway to consume
- ✅ 3.9 QR Ph prepay fallback — `supportsHold()` false → prepay intent, page copy switches to "Pay ₱…", unused amount refunded on capture
  - Verified: 30-check HTTP smoke test (`npm run smoke:p3`) + real-browser round-trip (Authorize click → webhook → `AUTHORIZED` → redirect back to the PWA)

### Phase 4 — Mock OCPP charger (simulator)

- ✅ 4.1 Charger gateway (`modules/chargers/gateway.ts`) consuming the normalized event set `session_started / meter_sample / session_ended / connector_status`; subscribes to `paymentsBus` for authorized → remote-start; unauthorized starts alarmed, never billed
- ✅ 4.2 Virtual charge point (`modules/chargers/mock-cp.ts`) — monotonic Wh meter register, `remote-start(sessionRef)` with spin-up delay ("Accepted ≠ started"), sample stream (configurable cadence + time-acceleration), stop reasons, offline queueing of the end event
- ✅ 4.3 Billing from **register delta** only (`amountForWh`): `(meterStop − meterStart) × tariff / 1000`, peso rounded half-up; capture clamped to the hold with an alarm
- ✅ 4.4 Start-timeout watchdog (90 s, env-tunable): rejected or silent starts → hold voided, connector freed, session `start_failed`
- ✅ 4.5 90%-of-hold soft-stop on the live sample stream — auto remote-stop before the cost exceeds the authorization
- ✅ 4.6 Connector availability driven by CP status events (`AVAILABLE / IN_USE / OFFLINE`); plus `POST /sessions/{id}/stop` for the driver's Stop action (202 async; 409 when not charging)
- ✅ 4.7 Simulator control panel — `/mock-cp/panel` (buttons + live state) over dev endpoints: reject start, silent start, unplug (EVDisconnected), vehicle full, power loss, offline/online
  - Verified: 36-check smoke test (`npm run smoke:p4`) — happy path with capture + receipt, register-delta math, watchdog, soft-stop bounds, unplug, power-loss queue-and-reconnect; caught and fixed a reentrancy bug in the sampler; Phases 2–3 smokes still pass

### Phase 5 — Wire the PWA to the API (replace every `TODO(api)`)

- ✅ 5.1 S1 code entry → real `GET /chargers/{code}` (auto-uppercase, format validation); unknown code → inline error
- ✅ 5.2 Real QR scanning — BarcodeDetector with vendored jsQR fallback (`apps/web/vendor/`), rear camera, decodes `/c/{slug}` URLs and bare `CHG-####` codes; graceful "camera unavailable" fallback to code entry. On-device validation happens in Phase 6 (camera needs the phone + HTTPS)
- ✅ 5.3 C2 "Hold & start" → session + checkout → full-page redirect to the hosted checkout → return poll → `AUTHORIZED` → "Starting charger…" → Live. Retry after `AUTH_FAILED`/`EXPIRED` **reuses the pending session** (connector shown as "reserved for you"); expired retry-session recreates cleanly
- ✅ 5.4 Live screen fully SSE-driven (₱, kWh, kW, SoC ring, hold bar with 75% warning); manual reconnect with exponential backoff; header flips to "Reconnecting…" after 10 s without data (data heartbeats every 15 s)
- ✅ 5.5 Session resume — `activeSessionId` in localStorage; reload mid-charge lands straight on Live and re-subscribes (verified live)
- ✅ 5.6 Stop flow → confirmation sheet → `POST /sessions/{id}/stop` → SSE `ended` event routes to Receipt rendered from server data (captured ₱, rate, hold released / refund-issued for prepay, mock OR number; refetches until capture finalizes)
- ✅ 5.7 Failure paths verified in-browser: payment failed → Start with retry; charger rejected start → "hold has been released" (incl. the fast-void race found and fixed); connector in use → CTA gated "in use right now"; invalid deep link → S1 error
- ✅ 5.8 C1 Quick Start card from real last-session data (hidden for first-time users); busy last charger swaps the caption; still confirms on the hosted page (real saved tokens are product Phase 2/3)
- ✅ 5.9 History from `GET /me/sessions` (dev-stub identity): month summary + insight line computed client-side, rows open their server-rendered receipts

### Phase 6 — Test on phone (mock end-to-end)

- ✅ 6.1 Phone-reachable HTTPS — `cloudflared` quick tunnel (no account needed) → `https://<random>.trycloudflare.com`; return-URLs and checkout redirects now derived from the request host (`trust proxy`), so localhost and the tunnel work simultaneously. Tunnel URL changes on restart — rerun `scripts/make-qr.mjs` after restarting it. (Optional later: named tunnel + owned domain via the Cloudflare account for a stable URL — needs the user to run `cloudflared tunnel login` themselves)
- ✅ 6.2 QR code generated (`node scripts/make-qr.mjs <base-url>`) encoding `/c/chg-0042-a1b2`; verified the deep link 302s to the app shell on the tunnel origin and a tunnel-created checkout redirects to a tunnel-hosted page
  - First phone test round (Aug 21) found 3 bugs, all fixed and re-verified through the tunnel: camera opening during payment confirmation (scanner now gated on the processing overlay); frozen live numbers + stuck stop (the quick tunnel silently buffers SSE — verified 0 bytes pass through; added `GET /sessions/{id}/live` and a client polling fallback that also catches `ended`/`start_failed`, so the tunnel path works at ~3 s cadence while SSE stays primary where it flows)
- ✅ 6.3 Happy path on a real phone (confirmed Aug 21): scan QR → confirm → mock checkout authorize → live updates → stop → receipt with register-delta math
- ✅ 6.4 Failure paths on the phone: decline at checkout, charger refuses start (hold voided), app reopened mid-charge (session resume), connectivity blip on Live (poll/SSE recovery)
- ✅ 6.5 Edge checks: zero-state Live screen on entry, stop lands on Receipt through the buffered-SSE tunnel, availability gating on a claimed connector
- ✅ 6.6 Milestone review — all phases ✅, three smoke suites green (23 + 30 + 36 checks), tagged `milestone-mock-e2e`

**🎉 MILESTONE REACHED: full drive-up → pay → charge → receipt flow works on a real phone with mock Maya and a mock OCPP charge point. Next: Stage 2 below.**

---

## STAGE 2 — Real integrations & launch path

Everything Stage 1 deliberately mocked or deferred. Phases 1 and 2 are
independent of each other (both slot in behind existing seams — the
`PaymentProvider` registry and the normalized charger-event set) and can run in
parallel; Phase 3 hardening should land before anything public.

### Stage 2 resources — external accounts, credentials & access

Everything Stage 2 needs from outside this repo, by phase it blocks. Status
lives in the table (✅/❌) so these don't skew the build-step completion count.
Expanded detail per item: BACKEND.md §8.

**Payments — Maya** *(blocks Phase 1; start the onboarding first — longest lead time)*

| Status | Resource | Detail | From |
|---|---|---|---|
| ❌ | Maya Business account | Merchant onboarding: business registration docs, settlement bank account | Business owner + Maya |
| ❌ | Maya sandbox API keys | Checkout API public/secret key pair for the sandbox spike | Maya developer portal |
| ❌ | Webhook registration | Our `/webhooks/maya` URL registered; webhook signing secret; their source IPs (needs the Phase 4 public URL, or a stable tunnel meanwhile) | Maya |
| ❌ | Capability confirmation | Auth/capture split per method (wallet / card / QR Ph), hold validity window, refund API, settlement cadence & fees — decides hold vs prepay lead | Maya onboarding contact |
| ❌ | Production keys | Issued after onboarding approval; Secrets Manager only, never in repo | Maya *(Phase 5)* |
| ❌ | Maya Vault (tokenization) | Saved payment methods → true one-tap Quick Start | Maya *(Phase 5)* |

**Chargers — CSMS / OCPP** *(blocks Phase 2)*

| Status | Resource | Detail | From |
|---|---|---|---|
| ❌ | Path decision (A/B) | Answers to the Charging_Synchronization.md §6 questionnaire — decides everything below | BTC Power charger platform team |
| ❌ | CSMS API credentials + docs | Remote start/stop, connector status, charger registry (path A) — or direct charger/OCPP access (path B) | Charger platform team |
| ❌ | CSMS event feed | `session.started` / `meter` / `ended` / `connector.status` as signed webhooks (or polling endpoint), with replay/transaction-detail endpoint | Charger platform team |
| ❌ | One pilot charger | Real unit with billing-grade meter, on a test tariff, physically accessible for testing | Operations |
| ❌ | Charger config rights | Ability to set `MeterValueSampleInterval=30`, `StopTxnSampledData` (energy register) on the pilot | Charger platform team |

**Infrastructure** *(blocks Phase 4)*

| Status | Resource | Detail | From |
|---|---|---|---|
| ❌ | GitHub remote for this repo | Currently local-only; prerequisite for CI (Phase 3.2) and deploys | Us — just push |
| ❌ | Domain + TLS | The URL printed in every QR code — pick once, early; DNS via the existing Cloudflare account | Business (domain purchase) + Cloudflare |
| ❌ | Hosting account | Fly.io / Railway / AWS for the pilot monolith | DevOps |
| ❌ | Managed PostgreSQL | Supabase or RDS (replaces dev SQLite) | DevOps |
| ❌ | Error monitoring + alert route | Sentry (or similar) + who gets paged on the capture dead-letter ("money in limbo") | DevOps |

**Communications & compliance** *(blocks Phase 5)*

| Status | Resource | Detail | From |
|---|---|---|---|
| ❌ | SMS provider account | PH-capable sender for receipts + OTP (Semaphore / M360 / Twilio); per-message cost feeds the channel decision | Product/finance |
| ❌ | Email sender | SES or equivalent with SPF/DKIM on the domain | DevOps |
| ❌ | BIR receipt registration | Official receipt series/numbering + format requirements for the PDF | Finance/accounting |
| ❌ | Tariff sign-off | ₱/kWh per site, idle fee, hold sizing bounds | Business |
| ❌ | Legal/regulatory review | ERC per-kWh resale rules, consumer disclosure, NPC privacy registration | Legal |
| ❌ | Pen test vendor | Security review before production exit | Security/procurement |

### Phase 1 — Real Maya (sandbox)

- ❌ 1.1 Maya Business onboarding + sandbox application → public/secret key pair
  (longest lead time in the whole stage — start first; see BACKEND.md §8)
- ❌ 1.2 Sandbox spike — throwaway script proving checkout → webhook →
  capture/void; answers the auth/capture-split question per method, which
  decides whether v1 leads with holds or prepay-refund
- ❌ 1.3 Real `MayaProvider` adapter behind the existing `PaymentProvider` seam
  (Checkout create, payment status, capture, void, refund)
- ❌ 1.4 Webhook registration — our `/webhooks/maya` URL, Maya's real signature
  scheme replacing the mock HMAC, source-IP allowlist question answered
- ❌ 1.5 Provider selected by config (`mock-maya` vs `maya-sandbox`) so dev and
  demo flows keep working without keys
- ❌ 1.6 Hold validity window + settlement cadence/fees confirmed and recorded
- ❌ 1.7 Full phone flow re-run against the Maya sandbox (test wallet / test cards)

### Phase 2 — Real chargers (CSMS / OCPP)

- ❌ 2.1 Path decision with the charger platform team: A — consume BTC Power's
  CSMS API, or B — own the OCPP sockets (questionnaire ready in
  Charging_Synchronization.md §6)
- ❌ 2.2 Credentials + docs for the chosen path (CSMS API access + event feed,
  or direct charger access for an OCPP gateway)
- ❌ 2.3 Real adapter translating CSMS events / OCPP 1.6J–2.0.1 into the
  normalized event set feeding the existing gateway (`session_started`,
  `meter_sample`, `session_ended`, `connector_status`)
- ❌ 2.4 Charger configuration for billing-grade data:
  `MeterValueSampleInterval=30`, `StopTxnSampledData` ⊇ energy register
- ❌ 2.5 One pilot charger registered with QR slug on a test tariff
- ❌ 2.6 Reconciliation: transaction-detail/replay endpoint wired for gap
  healing; `awaiting_final_meter` handling per Charging_Synchronization.md §4.5
- ❌ 2.7 End-to-end session on the real charger (with mock or sandbox Maya —
  still no real money)

### Phase 3 — Hardening (before anything public)

- ❌ 3.1 Test runner + unit tests for the state machines and billing math
  (promote the smoke-script checks into a real suite)
- ❌ 3.2 CI — GitHub Actions running typecheck + all suites on every commit
- ❌ 3.3 Automated browser E2E (Playwright): happy path + failure paths
- ❌ 3.4 Security pass — auth/gating on dev surfaces (`/mock-cp/*`, `/me/*`),
  rate limiting, security headers, `npm audit` triage
- ❌ 3.5 Concurrency + hostile-input pass — simultaneous connector claims,
  malformed payloads against every endpoint
- ❌ 3.6 Cross-device / cross-browser pass (iOS Safari + Android Chrome minimum)
- ❌ 3.7 Accessibility pass (contrast, touch targets, screen-reader labels)

### Phase 4 — Pilot deployment

- ❌ 4.1 SQLite → PostgreSQL migration (managed — Supabase or RDS; raw-SQL
  ledger transactions land here too, per BACKEND.md §3)
- ❌ 4.2 Host the monolith — Fly.io / Railway / single ECS service; Redis when
  more than one instance serves SSE
- ❌ 4.3 Domain + TLS — the URL printed in every QR code, chosen once
  (Cloudflare account: named tunnel or DNS in front of the host)
- ❌ 4.4 Secrets management + monitoring — provider keys out of the repo,
  error tracking, and the capture dead-letter alert ("money in limbo" pages)
- ❌ 4.5 Pilot dry-run at one site: real charger + sandbox Maya + printed QR

### Phase 5 — Launch readiness

- ❌ 5.1 BIR official receipts — series/numbering registration, compliant PDF,
  SMS/email delivery (provider costs feed the channel decision)
- ❌ 5.2 OTP accounts (phone/email) unlocking History across devices
- ❌ 5.3 Maya production keys + Vault tokenization → true one-tap Quick Start
- ❌ 5.4 Business & legal — tariff sign-off, ERC/per-kWh resale rules, privacy
  (NPC), pen test before exit
- ❌ 5.5 Production hosting per BACKEND.md §5 (AWS ap-southeast-1, Multi-AZ)
