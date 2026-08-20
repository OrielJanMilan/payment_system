# Development Progress

Step-by-step tracker from the current basepoint to **Milestone: full flow tested
on a phone with a mock Maya and a mock OCPP charger** — no real payment, no real
charger link. Nothing beyond that milestone is tracked here.

Legend: ✅ done · ❌ not done. Work top-to-bottom; each phase builds on the one
above it. When a step is completed, verified, and reviewed, flip its ❌ to ✅.

References: [BACKEND.md](BACKEND.md) · [SCREEN_FUNCTIONALITY.md](SCREEN_FUNCTIONALITY.md) ·
[Charging_Synchronization.md](Charging_Synchronization.md)

---

## Phase 0 — Design basepoint

- ✅ Screen & element functional spec (`SCREEN_FUNCTIONALITY.md`)
- ✅ Backend architecture design (`BACKEND.md`)
- ✅ Charging synchronization / OCPP data contract (`Charging_Synchronization.md`)
- ✅ Design mockups — Options A, B, C (`design/`)
- ✅ Option C UI prototype, client-side simulated (`ui/` — all API calls are `TODO(api)` stubs)

## Phase 1 — Project scaffolding

- ❌ 1.1 `git init` the repo; add `.gitignore`, first commit of the basepoint
- ❌ 1.2 Repo layout per BACKEND.md §4: `apps/api/` (backend), `apps/web/` (move `ui/` here), `packages/shared/` (DTOs)
- ❌ 1.3 Backend skeleton — Node 22 + TypeScript (Express or NestJS), config loading, `GET /health`
- ❌ 1.4 Dev database — SQLite (file-based; keeps the mock milestone Postgres-free) with migrations for: `chargers`, `sessions`, `payment_intents`, `provider_events`
- ❌ 1.5 Seed data — one virtual site + charger `CHG-0042` (CCS2, 60 kW, ₱48.50/kWh tariff, ₱1,500 hold) + its `qr_slug`
- ❌ 1.6 Static serving of the PWA from the API process (one origin — no CORS, one URL for the phone)
- ❌ 1.7 `.claude/launch.json` dev-server entry so the app runs with one command

## Phase 2 — Sessions module + charger registry (API surface the UI needs)

- ❌ 2.1 `GET /chargers/{code}` — charger lookup by printed code (S1 "Go" button) with connector status
- ❌ 2.2 `GET /c/{qr_slug}` deep-link route — resolves slug → charger, serves the PWA landed on the Start screen (invalid slug → S1 error state)
- ❌ 2.3 `POST /sessions` — create session in `pending_payment`, pin the tariff, compute the hold server-side; 10-min expiry
- ❌ 2.4 Session state machine: `pending_payment → pending_start → charging → ended` (+ `expired`, `start_failed`) with idempotent transitions
- ❌ 2.5 `GET /sessions/{id}` — session detail (state, kWh, running ₱, receipt fields)
- ❌ 2.6 `GET /sessions/{id}/events` — SSE stream for the Live screen (state changes + meter samples)

## Phase 3 — Mock Maya payment provider

- ❌ 3.1 `PaymentProvider` interface + registry — the seam from BACKEND.md §1; only `providers/` code knows provider types
- ❌ 3.2 Payment intent state machine: `CREATED → PENDING_AUTH → AUTHORIZED → CAPTURING → CAPTURED` + `AUTH_FAILED / EXPIRED / VOIDED` (per SCREEN_FUNCTIONALITY.md mapping table)
- ❌ 3.3 `MockMaya` adapter — `createCheckout` returns a redirect URL to a local hosted-checkout page; `capture`, `void`, `refund` implemented against in-memory/mock state
- ❌ 3.4 Mock hosted-checkout page — mimics the Maya redirect: shows amount + method, buttons for **Authorize**, **Fail**, **Let it expire**; redirects back to the app's success/failure URL
- ❌ 3.5 Mock webhook flow — the checkout page's outcome fires a signed (HMAC) webhook to `POST /webhooks/maya`; handler verifies signature, persists raw payload to `provider_events`, applies idempotent intent transition (unique `event_id`)
- ❌ 3.6 `POST /payments/checkout` — creates checkout via the registry-resolved adapter, returns redirect URL (S3 / C2 "Hold & start")
- ❌ 3.7 Intent polling endpoint for the return-from-checkout wait (`GET /payments/{id}`)
- ❌ 3.8 Capture on session end — exact metered amount captured, remainder "released"; void on charger-start failure
- ❌ 3.9 QR Ph prepay fallback path — intent flagged prepay, "refund" of unused amount on completion (mocked)

## Phase 4 — Mock OCPP charger (simulator)

- ❌ 4.1 `chargers` module with the normalized internal event set: `session_started`, `meter_sample`, `session_ended`, `connector_status` (Charging_Synchronization.md §1 adapter note)
- ❌ 4.2 Virtual charge point — in-process simulator holding a meter register (Wh) per connector; accepts `remote-start(sessionRef)` / `remote-stop`, emits `StartTransaction`-equivalent (meterStart), periodic meter samples (accelerated cadence for demo), `StopTransaction`-equivalent (meterStop, reason)
- ❌ 4.3 Billing math from **register delta** only: `(meterStop − meterStart)/1000 × pinned tariff`, peso rounded half-up at the end — never the sample sum
- ❌ 4.4 Start-timeout watchdog: no `session_started` within 90 s of accepted remote-start → void hold, free connector, session `start_failed` (S3 off-screen behavior)
- ❌ 4.5 90%-of-hold soft-stop: backend auto-stops the session before the running cost exceeds the authorization
- ❌ 4.6 Connector availability: simulator drives `AVAILABLE / IN USE / OFFLINE` for the S2/C2 pill; CTA gated when not available
- ❌ 4.7 Simulator control panel (dev-only page or endpoints) to force scenarios: refuse start, stop reason `EVDisconnected`, go offline mid-session, vehicle-full stop

## Phase 5 — Wire the PWA to the API (replace every `TODO(api)`)

- ❌ 5.1 S1 code entry → real `GET /chargers/{code}`; unknown code → inline error
- ❌ 5.2 Real QR scanning in the viewfinder (BarcodeDetector with jsQR fallback); decoded deep link → Start screen
- ❌ 5.3 C2 "Hold & start" → `POST /sessions` + `POST /payments/checkout` → full-page redirect to the mock hosted checkout → on return, poll intent until webhook lands → `AUTHORIZED` → Live; `AUTH_FAILED/EXPIRED` → back with inline error
- ❌ 5.4 Live screen driven by SSE (kWh, ₱, kW, SoC, hold bar) instead of the client-side timer; reconnect with backoff + "reconnecting" hint after 10 s
- ❌ 5.5 Session resume — active session id in `localStorage`; reopening while `charging` routes straight to Live and re-subscribes
- ❌ 5.6 Stop flow → `POST /sessions/{id}/stop` → server captures exact amount → Receipt rendered from server data (captured ₱, hold released, mock OR number)
- ❌ 5.7 Failure-path UI verified end-to-end: auth failed, checkout expired, charger start failed (hold released message), charger unavailable
- ❌ 5.8 C1 Quick Start card backed by real last-session data + mock saved payment token (or hidden for first-time users)
- ❌ 5.9 History screen served from `GET /me/sessions` mock data (no OTP — dev-stub identity only for this milestone)

## Phase 6 — Test on phone (mock end-to-end)

- ❌ 6.1 Phone-reachable HTTPS — camera + PWA APIs require a secure context: LAN HTTPS via `mkcert`/Caddy, or a tunnel (ngrok / cloudflared); one URL serves app + API
- ❌ 6.2 Printable QR code generated for the seeded charger encoding `https://<dev-host>/c/{qr_slug}`
- ❌ 6.3 Happy path on a real phone: scan QR → confirm → mock checkout authorize → live updates stream → stop → receipt matches register-delta math
- ❌ 6.4 Failure paths on the phone: decline at checkout, charger refuses start (hold voided), app closed and reopened mid-charge (session resume), airplane-mode blip during Live (SSE reconnect)
- ❌ 6.5 Edge checks on the phone: 90% hold soft-stop fires, `EVDisconnected` stop lands on Receipt, availability pill blocks an `IN USE` connector
- ❌ 6.6 Milestone review — walk the whole checklist above, fix gaps, then tag/commit `milestone-mock-e2e`

---

## Out of scope for this milestone (deliberately not tracked)

Real Maya sandbox/production keys · real CSMS/OCPP connection and pilot charger ·
double-entry ledger · BIR receipt numbering, PDF, SMS/email delivery · OTP accounts ·
hosting/AWS/CI · everything in BACKEND.md §8 marked P1/Launch. These start only
after `milestone-mock-e2e` passes on a phone.
