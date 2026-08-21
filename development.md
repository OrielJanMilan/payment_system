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

- ✅ 1.1 `git init` the repo; add `.gitignore`, first commit of the basepoint
- ✅ 1.2 Repo layout per BACKEND.md §4: `apps/api/` (backend), `apps/web/` (moved from `ui/`), `packages/shared/` (DTOs)
- ✅ 1.3 Backend skeleton — Node + TypeScript + Express (module boundaries as folders; framework-agnostic core), config loading, `GET /health`
- ✅ 1.4 Dev database — SQLite via built-in `node:sqlite`, migration runner (`PRAGMA user_version`), tables: `chargers`, `connectors`, `sessions`, `payment_intents`, `provider_events`
- ✅ 1.5 Seed data — one virtual site + charger `CHG-0042` (CCS2, 60 kW, ₱48.50/kWh tariff, ₱1,500 hold) + `qr_slug` `chg-0042-a1b2`
- ✅ 1.6 Static serving of the PWA from the API process (one origin — no CORS, one URL for the phone)
- ✅ 1.7 `.claude/launch.json` dev-server entry (`app` → `npm run dev`, port 3000)

## Phase 2 — Sessions module + charger registry (API surface the UI needs)

- ✅ 2.1 `GET /chargers/{code}` — charger lookup by printed code (case-insensitive) with connector status; 404 on unknown
- ✅ 2.2 `GET /c/{qr_slug}` deep-link route — resolves slug, redirects to the app shell (`/?c={slug}`; invalid → `/?error=charger-not-found` for the S1 error state); plus `GET /chargers/by-slug/{slug}` for the client's data load
- ✅ 2.3 `POST /sessions` — creates session in `pending_payment`, pins the tariff, computes the hold server-side, atomically claims the connector (409 when unavailable); 10-min TTL
- ✅ 2.4 Session state machine (`modules/sessions/service.ts`) — guarded idempotent transitions incl. `expired` (lazy on read + 30 s sweep) and `start_failed`; connector released on terminal states; 23-check smoke test (`npm run smoke`)
- ✅ 2.5 `GET /sessions/{id}` — session detail (state, pinned tariff/hold, meter + billing fields)
- ✅ 2.6 `GET /sessions/{id}/events` — SSE stream: initial state snapshot, published state/meter events, 15 s heartbeats

## Phase 3 — Mock Maya payment provider

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
