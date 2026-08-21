# QA Software Testing Checklist

Essential QA test areas for the EV charging payment system, marked against the
current state of the project (mock Maya + mock OCPP charger milestone).

Legend: ✅ done · ❌ not done

References: [development.md](development.md) · [BACKEND.md](BACKEND.md) ·
[SCREEN_FUNCTIONALITY.md](SCREEN_FUNCTIONALITY.md)

---

**Overall progress: 27 / 43 — 63% accomplished**

## 1. Functional testing (API)

- ✅ Charger lookup — `GET /chargers/{code}` valid, unknown (404), case-insensitive
- ✅ QR deep link — `GET /c/{qr_slug}` resolves; invalid slug → error state
- ✅ Session creation — tariff pinned, hold computed server-side, connector claimed atomically (409 when busy), 10-min TTL
- ✅ Session state machine — guarded idempotent transitions incl. `expired` and `start_failed` (23-check smoke: `npm run smoke`)
- ✅ Payment intent state machine — auth/capture/void/refund/expire paths (30-check smoke: `npm run smoke:p3`)
- ✅ Webhook handling — HMAC signature verified (timing-safe), replayed `event_id` is a no-op
- ✅ Billing math — register-delta only, peso rounding half-up, capture clamped to hold (36-check smoke: `npm run smoke:p4`)
- ✅ Charger fault paths — start watchdog, soft-stop at 90% of hold, unplug, power-loss queue-and-reconnect

## 2. Functional testing (UI / end-to-end, desktop browser)

- ✅ Code entry → charger found / inline error on unknown code
- ✅ Full happy path — Hold & start → hosted checkout → authorize → live screen → stop → receipt
- ✅ Live screen SSE-driven (₱, kWh, kW, SoC, hold bar) with reconnect + backoff
- ✅ Session resume after page reload mid-charge
- ✅ Failure paths — payment declined, charger rejected start (hold released), connector in use, invalid deep link
- ✅ Prepay (QR Ph) fallback flow with refund of unused amount
- ✅ Quick Start card and History screen from real API data

## 3. Mobile / device testing (real phone over HTTPS tunnel)

- ✅ Phone-reachable HTTPS via cloudflared tunnel; redirects derived from request host
- ✅ QR code scan → deep link → app shell on the tunnel origin
- ✅ First bug-hunt round (Aug 21) — 3 bugs found, fixed, re-verified (camera gating, SSE buffered by tunnel → polling fallback)
- ❌ Happy path end-to-end on phone — scan → pay → live updates → stop → receipt matches billing math
- ❌ Failure paths on phone — decline at checkout, refused start, app closed/reopened mid-charge, airplane-mode blip
- ❌ Edge checks on phone — 90% soft-stop fires, `EVDisconnected` lands on receipt, `IN USE` connector blocked
- ❌ Cross-device / cross-browser pass (iOS Safari + Android Chrome at minimum)

## 4. Regression testing

- ✅ Cumulative smoke suites — later phases re-run earlier phase smokes (Phases 2–3 still pass after Phase 4)
- ❌ Automated unit tests (no test runner / `*.test.ts` files in the repo)
- ❌ CI pipeline running the suites on every commit
- ❌ Automated browser E2E (e.g. Playwright) replacing manual browser verification

## 5. Negative & edge-case testing

- ✅ Invalid inputs — unknown charger code, bad slug, unpayable session (409), reused checkout page (410)
- ✅ Race conditions — fast-void race found and fixed; sampler reentrancy bug caught by smoke test
- ✅ Timeout behavior — session TTL expiry, 90 s start watchdog, silent start
- ❌ Concurrency at scale — two phones claiming the same connector simultaneously
- ❌ Malformed/hostile payloads against every endpoint (fuzz-style pass)

## 6. Security testing

- ✅ Webhook signature verification (timing-safe HMAC) + replay protection
- ✅ Server-side authority — tariff, hold, and billing never trusted from the client
- ❌ Dedicated security review of the branch (auth on dev/panel endpoints, rate limiting, header hardening)
- ❌ Dependency vulnerability audit (`npm audit` triage)

## 7. Performance & reliability testing

- ✅ SSE heartbeats + client reconnect/backoff; polling fallback where SSE is buffered
- ❌ Load testing (many concurrent sessions / SSE subscribers)
- ❌ Long-run soak test (multi-hour charge session, meter drift, memory leaks)
- ❌ Slow-network / high-latency simulation beyond the tunnel path

## 8. Usability & acceptance

- ✅ Screen behavior matches the functional spec (`SCREEN_FUNCTIONALITY.md`) for implemented flows
- ✅ Zero-state handling — live screen starts clean until the first real meter sample
- ❌ Milestone acceptance review — full checklist walk, then tag `milestone-mock-e2e`
- ❌ Accessibility pass (contrast, touch targets, screen reader labels)

---

## Summary

| Area | Done | Not done |
|---|---|---|
| Functional (API) | 8 | 0 |
| Functional (UI/E2E browser) | 7 | 0 |
| Mobile / device | 3 | 4 |
| Regression | 1 | 3 |
| Negative & edge cases | 3 | 2 |
| Security | 2 | 2 |
| Performance & reliability | 1 | 3 |
| Usability & acceptance | 2 | 2 |
| **Total** | **27** | **16** |

**Next up:** the remaining phone-test passes (§3) — they gate the
`milestone-mock-e2e` acceptance review in §8.
