# Screen & Element Functionality

Functional spec for the driver-facing EV charging payment app (mobile web / PWA).
Applies to the **Option A** and **Option B** mockups in [`design/`](design) — those two
differ only visually; every element below behaves the same in either. **Option C**
compresses the same flow into five screens; its deltas are specced at the
[end of this document](#option-c-flow-deltas).

Reference: system design blueprint (architecture, payment states, provider abstraction)
— see the published blueprint doc. Amounts shown in mockups are examples at ₱48.50/kWh.

---

## Global behaviors

| Behavior | Functionality |
|---|---|
| Deep link `/c/{qr_slug}` | The URL encoded in each charger's QR code. Opening it skips S1 and lands directly on S2 for that charger/connector. Invalid or unknown slug → error state on S1 with "Charger not found — check the code". |
| Session resume | An active session id is kept in `localStorage`. Reopening the app (or the browser reopening the tab) while a session is `charging` routes straight to S4 and re-subscribes to live updates. |
| Live updates (SSE) | S4 subscribes to `GET /sessions/{id}/events` (Server-Sent Events). On disconnect, exponential-backoff reconnect; UI shows a "reconnecting" hint after 10 s without data. Charging itself is unaffected by client disconnects. |
| Auth model | Guest-first. No login wall anywhere in S1–S5. A lightweight OTP account (phone or email) exists only to unlock S6 history. |
| Currency & locale | PHP only in v1. All money rendered with `₱` and two decimals; energy in kWh (one decimal); power in kW. |
| Errors (general) | Every failed action shows an inline, non-blocking error with a retry action; no dead ends. Payment failures never leave the charger energized. |

---

## S1 · Scan / Landing (`Main`)

Entry point when the app is opened without a QR deep link.

| Element | Type | Functionality |
|---|---|---|
| Wordmark ("Option A/B" placeholder) | Static | Brand slot. Tapping it is a no-op (v1). Replaced by the real product name once a direction is chosen. |
| Headline + subline | Static | Value proposition. No interaction. |
| Camera viewfinder | Live camera view | Requests camera permission on first render (browser prompt). Continuously scans for QR codes. On successful decode of a valid charger QR → navigate to S2 for that charger. Permission denied or no camera → viewfinder collapses into a message steering the user to the code entry below. |
| Scan line / corner brackets | Decorative | Scanning affordance only. |
| Charger code input (`CHG-0042`) | Text input | Manual fallback. Accepts the printed code on the charger (format `CHG-####`). Auto-uppercases; validates format on submit. |
| **Go** button | Primary action | Submits the code → `GET /chargers/{code}`. Found → S2. Not found → inline error under the field ("No charger with that code"). Disabled while the lookup is in flight. |
| Trust footer ("Pay only for what you charge · Secured by Maya") | Static | Reassurance copy. No interaction. |

---

## S2 · Charger & Rate confirm (`Confirm`)

Loaded per charger from `GET /chargers/{id}`. This is the page the QR deep link opens.

| Element | Type | Functionality |
|---|---|---|
| Back button | Navigation | Returns to S1. |
| Charger ID header | Static | Confirms the user is at the right charger — must match the label on the hardware. |
| Site name + bay ("Ayala Malls Manila Bay · Basement 2 · Bay 14") | Static | Location confirmation, from the charger registry. |
| Availability pill (`AVAILABLE`) | Status indicator | Live connector status: `AVAILABLE` (green) / `IN USE` / `OFFLINE`. When not available, the primary CTA is disabled and the pill explains why. Refreshed on page load and via a light poll (~15 s). |
| Connector chip(s) ("CCS2 · DC fast · up to 60 kW") | Static / selector | Shows connector type and max power. If a charger has multiple connectors, these become a selector; the chosen connector is passed to session creation. |
| Rate figure ("₱48.50 / kWh") | Static | The tariff pinned for this session, resolved from the site's active tariff version at page load. What the session will actually bill at. |
| Idle-fee note | Static | Discloses the post-charge idle fee (₱/min after a grace period) so it is agreed to before starting. |
| Hold explainer card ("₱1,500.00 hold to start…") | Static | Discloses the pre-authorization amount and the pay-for-what-you-use rule. The amount is computed server-side per site (see blueprint §3, hold sizing) and rendered here — never hard-coded client-side. |
| **Continue to payment** | Primary action | `POST /sessions` with charger + connector → creates a session in `pending_payment` and a payment intent in `CREATED` → navigates to S3. Disabled when the connector isn't available. Failure → inline retry. |
| "No account needed" caption | Static | Reassurance. No interaction. |

---

## S3 · Payment method hand-off (`Pay`)

The last screen before leaving for the provider's hosted page. Nothing on this screen
ever touches raw card data.

| Element | Type | Functionality |
|---|---|---|
| Back button | Navigation | Returns to S2. The session stays `pending_payment` for 10 min, then expires server-side. |
| Hold amount summary ("₱1,500.00 · covers up to ~30 kWh") | Static | Restates exactly what will be authorized. Must match the amount on the CTA button 1:1. |
| Method row — **Maya Wallet** (pre-selected) | Radio selection | Selects wallet as the checkout method. Default selection because it has the fewest steps. |
| Method row — **Credit / debit card** | Radio selection | Selects card. Cards are entered on Maya's hosted page only. |
| Method row — **QR Ph** | Radio selection | Selects QR Ph. Note: if the provider can't do an auth/capture hold for this method, the backend switches this intent to the prepay fallback (charge the hold amount now, refund the unused part after the session) — the button copy updates to "Pay ₱1,500.00 (unused amount refunded)". |
| Security note ("redirected to Maya… card details never touch our servers") | Static | PCI-scope disclosure. No interaction. |
| **Authorize ₱1,500.00 hold** | Primary action | `POST /payments/checkout` with the selected method → backend calls the provider adapter's `createCheckout` → responds with a redirect URL → full-page redirect to the hosted checkout. On return (success URL), the app polls the intent until the webhook lands: `AUTHORIZED` → charger start is triggered and the app navigates to S4; `AUTH_FAILED`/`EXPIRED` → back here with an inline error and the method list re-enabled. |

**Off-screen behavior after authorization:** backend sends `RemoteStartTransaction`
to the charger. If the charger fails to start within its timeout, the hold is voided
automatically and the user is returned to S2 with "Couldn't start this charger — the
hold has been released. Try another connector."

---

## S4 · Charging Live (`Live`)

The screen drivers keep open (or return to) during the session. All data via SSE.

| Element | Type | Functionality |
|---|---|---|
| Header ("Charging" + site) | Static | Session context. |
| Charger ID pill | Static | Match-the-hardware confirmation. |
| Progress ring + battery % | Live indicator | Vehicle state of charge when the charger reports it (typical on DC). If SoC is unavailable (most AC sessions), the ring switches to an indeterminate "energy delivered" animation and the center shows kWh instead of %. |
| "₱ charged so far" figure | Live counter | Running cost = metered kWh × pinned tariff, recomputed on every meter value (~30 s). This is the number the final capture will be based on. |
| Stats tiles — kW now / kWh delivered / min elapsed | Live counters | Instantaneous power, cumulative energy, elapsed time from the meter value stream. |
| Hold usage bar ("₱611.10 of ₱1,500.00") | Live progress | Running cost as a fraction of the hold. At **90%** of the hold the backend soft-stops the session automatically (never exceeds the authorization); the bar turns to a warning state as it approaches. |
| **Stop charging** | Destructive-styled action | Confirmation sheet ("Stop charging now?") → `POST /sessions/{id}/stop` → backend sends `RemoteStopTransaction`, takes the final meter read, captures the exact amount, releases the rest → navigates to S5. Also triggered externally by: unplugging the cable, the vehicle reaching full, or the hold cap — all of which land the user on S5 the same way. |
| "Safe to close this page" caption | Static | Sets the expectation that charging is server/charger-side; the page is just a viewport. |

---

## S5 · Receipt (`Receipt`)

Terminal state of the happy path. Shown after capture completes; reachable again later
from S6.

| Element | Type | Functionality |
|---|---|---|
| Success check + "Charging complete" | Status | Confirms capture succeeded. If capture is still retrying when the user lands here, this renders a "Finalizing payment…" state and resolves in place — the user never sees a wrong amount. |
| Amount figure ("₱892.40 · paid via Maya Wallet") | Static | The captured amount — the metered figure, not the hold. Shows method and timestamp. |
| Detail rows — energy / duration / rate | Static | The billing math, itemized: kWh × rate = amount. |
| Detail rows — hold placed / **hold released** | Static | Makes the release explicit (hold − captured = released). For prepay-fallback sessions the released row reads "Refund issued" with the provider's refund timeline. |
| Official receipt block (`OR-2026-081942`) | Static | BIR-sequenced receipt number. The receipt is immutable once issued. |
| "Sent to +63 917 ··· 4482" | Static | Where the receipt copy went (the contact captured at checkout). |
| **Download receipt** | Secondary action | Downloads the official receipt PDF (`GET /receipts/{id}/pdf`). |
| **Done** | Primary action | Ends the flow → S1 (or S6 if signed in). Clears the active-session pointer. |

---

## S6 · History (`History`) — account holders only

Requires the optional OTP account. Never required for paying.

| Element | Type | Functionality |
|---|---|---|
| Header + masked phone | Static | Identifies the signed-in account. |
| Monthly summary ("AUGUST 2026 · ₱3,210.70 · 4 sessions · 66.2 kWh") | Static / navigable | Aggregates the visible month. Swipe or month selector to move between months (v1: current + past 12). |
| Session row (site · date · kWh · duration · amount) | List item → navigation | One row per completed session, newest first. Tap → that session's S5 receipt view. Paginated (`GET /me/sessions?cursor=`). |
| Chevron | Affordance | Indicates the row is tappable. |
| SMS note footer | Static | Reminds that receipts also arrive per session without an account. |

---

## Element → state machine mapping

How on-screen actions drive the payment intent lifecycle (blueprint §4):

| UI event | Intent transition |
|---|---|
| S2 "Continue to payment" | — (intent `CREATED`) |
| S3 "Authorize hold" → hosted checkout opened | `CREATED → PENDING_AUTH` |
| Maya webhook: payment authorized | `PENDING_AUTH → AUTHORIZED` (charger starts, S4) |
| Maya webhook: failed / expired | `PENDING_AUTH → AUTH_FAILED / EXPIRED` (back to S3) |
| Charger fails to start | `AUTHORIZED → VOIDED` (back to S2) |
| S4 "Stop charging" (or auto-stop) | `AUTHORIZED → CAPTURING` |
| Provider confirms capture | `CAPTURING → CAPTURED` (S5) |
| Capture retry exhausted | `CAPTURING → CAPTURE_FAILED` (manual review; S5 shows "Finalizing…") |
| Support-initiated refund (not in driver UI, v1) | `CAPTURED → REFUNDED` |

---

## Option C flow deltas

Option C keeps every behavior above but restructures the screens for speed and
simplicity: five screens instead of six, two taps from scan to charging.

| Delta | Functionality |
|---|---|
| **C1 Quick Start card** (new, on Scan) | Rendered only for returning drivers (last session stored locally + a saved provider payment token). Shows last charger, rate, and method. One tap runs the whole S2+S3 sequence with the remembered inputs: create session → create checkout with the saved method → hosted-page confirmation only if the provider requires it → S4. If the remembered charger is unavailable, the card swaps to "last charger busy — scan to pick another". |
| **C2 Start screen** (replaces S2 + S3) | Charger confirm, rate, method chips (Maya Wallet pre-selected), and the hold disclosure on one screen. Single CTA **"Hold & start charging"** = `POST /sessions` + `POST /payments/checkout` chained server-side in one call. All S2/S3 element behaviors (availability gating, method fallback rules, error returns) apply unchanged. |
| **C3 engagement line** (on Live) | One pill: `+km added (est.) · 80% ≈ ETA`. Range estimate = kWh × a conservative km/kWh factor (labelled "est."); ETA from the charger's reported charge curve. Hidden when the vehicle reports no SoC. |
| **C4 eco line** (on Receipt) | One line: range added + CO₂ avoided vs gasoline (both labelled "est."; factors configurable server-side). "Download PDF" becomes a text link; single **Done** CTA. |
| **C5 insight line** (on History) | One line: estimated km driven on this month's charge. No other additions. |
| Removed relative to A/B | The standalone payment-method screen (S3) and its duplicated hold summary; second button on Receipt. Nothing else is removed — all error paths, the state machine, and global behaviors are identical. |
