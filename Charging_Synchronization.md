# Charging Synchronization

How the payment system gets accurate charging data — kWh, start, stop, status —
from the chargers, via OCPP and/or the CSMS. Design document, nothing implemented yet.
Companion to [BACKEND.md](BACKEND.md) (§2 decides whether we consume the CSMS API —
path A — or speak OCPP ourselves — path B; the data contract below is the same either way).

**The core rule:** the driver is billed from the charger's **meter register delta**
(`meterStop − meterStart`), never from summing the live sample stream. Samples power
the live screen; the register delta powers the invoice.

---

## 1. The OCPP messages that matter

### OCPP 1.6J (most deployed fleet today)

| Message | Direction | What we need from it |
|---|---|---|
| `RemoteStartTransaction.req` | CSMS → CP | Our trigger after payment is authorized. Carries `connectorId` and an `idTag` — we set the idTag to a **session token we minted**, which is how the eventual transaction is correlated back to our session. `.conf Accepted` ≠ charging started; it only means the charger will try. |
| `StartTransaction.req` | CP → CSMS | The authoritative session start: `meterStart` (Wh), `timestamp`, `connectorId`, the `idTag` we issued. CSMS assigns the `transactionId`. This is the moment S4 (Charging Live) becomes real. |
| `MeterValues.req` | CP → CSMS | The live stream: sampled `Energy.Active.Import.Register` (Wh), `Power.Active.Import` (kW), `SoC` (%). Feeds the live screen only. |
| `StopTransaction.req` | CP → CSMS | The authoritative end: `meterStop` (Wh), `timestamp`, `reason` (`Remote`, `Local`, `EVDisconnected`, `PowerLoss`, …), optional `transactionData` (stop-time samples). **Capture is computed from this message.** |
| `StatusNotification.req` | CP → CSMS | Connector state: `Available / Preparing / Charging / SuspendedEV / SuspendedEVSE / Finishing / Faulted`. Drives the AVAILABLE pill on S2/C2 and our watchdogs. |
| `RemoteStopTransaction.req` | CSMS → CP | Our trigger when the driver taps Stop (or the hold cap / soft-stop fires). |

Charger configuration keys that must be set for billing-grade data (via
`ChangeConfiguration`, once per charger):

- `MeterValueSampleInterval` = **30** (seconds) — the live-screen cadence
- `MeterValuesSampledData` = `Energy.Active.Import.Register,Power.Active.Import,SoC`
- `StopTxnSampledData` ⊇ `Energy.Active.Import.Register` — samples attached to the stop message, our backfill source
- `ClockAlignedDataInterval` optional (nice for site energy reporting, not needed for billing)

### OCPP 2.0.1 (newer fleet)

Same shape, cleaner envelope: `RequestStartTransaction` carries a `remoteStartId`
that the charge point echoes in its `TransactionEvent(Started)` — explicit
correlation instead of the idTag trick. `TransactionEvent (Started / Updated / Ended)`
replaces StartTransaction / MeterValues / StopTransaction, each event carrying
`meterValue` and a `transactionInfo.transactionId`. `Ended` carries the stop reason
and final register value.

Adapter note: our `chargers` module should normalize both dialects into one internal
event set — `session_started`, `meter_sample`, `session_ended`, `connector_status` —
so the sessions/payments modules never know which OCPP version produced them.

## 2. What we need from the CSMS (integration contract — path A)

If BTC Power's existing CSMS holds the OCPP connections, this is the API surface we
need it to expose. This list doubles as the questionnaire for the CSMS team.

**Commands (synchronous API):**

1. `POST remote-start(chargerId, connectorId, sessionRef)` — must pass our
   `sessionRef` through as idTag / remoteStartId so the transaction is correlated
2. `POST remote-stop(transactionId)`
3. `GET connector-status(chargerId)` — live status for S2/C2 availability
4. Charger registry read — chargers, connectors, max kW (to seed our `chargers` mirror and QR slugs)

**Events (webhooks to us, or a stream we can consume):**

5. `session.started` — transactionId, our sessionRef, **meterStart (Wh)**, timestamp
6. `session.meter` — transactionId, sampled energy/power/SoC, timestamp (~30 s cadence)
7. `session.ended` — transactionId, **meterStop (Wh)**, timestamp, stop reason, any stop-time samples
8. `connector.status` — status changes (for availability and watchdogs)

**Contract qualities (as important as the endpoints):**

- **Delivery**: at-least-once with an `event_id` for idempotent processing on our side;
  what is the ordering guarantee? (We tolerate out-of-order samples; we must not
  process `ended` twice.)
- **Replay/backfill**: `GET events?since=` or `GET transaction/{id}` so we can heal
  gaps after our downtime or theirs. A transaction detail endpoint returning
  meterStart/meterStop/reason is the minimum.
- **Latency**: `session.started` and `session.ended` should reach us in seconds —
  `started` gates the driver seeing "charging", `ended` gates their money being captured.
- **Timestamps**: whose clock? Prefer CSMS receive-time alongside CP-reported time
  (charge point clocks drift; Heartbeat sync helps but doesn't guarantee).
- **Auth**: signed webhooks (shared secret/HMAC) exactly like we treat Maya's.

If the CSMS cannot provide 5–8 as push events but can be polled, the design still
works with a 10–15 s poller — worse live-screen latency, same billing accuracy,
since billing depends only on the final register values.

## 3. End-to-end sequence (happy path)

```
Payment AUTHORIZED (Maya webhook)
  → we call remote-start(charger, connector, sessionRef)
  → CP: StartTransaction (meterStart = 1,204,320 Wh)   ← session ACTIVE, S4 live
  → MeterValues every 30 s                              ← SSE to driver: kWh, ₱, kW, SoC
  → driver taps Stop → we call remote-stop(txId)
  → CP: StopTransaction (meterStop = 1,222,720 Wh, reason=Remote)
  → billedKwh = (1,222,720 − 1,204,320) / 1000 = 18.4 kWh
  → cost = 18.4 × ₱48.50 = ₱892.40 → capture ₱892.40, release ₱607.60
```

Timeouts on the way in: if no `session.started` arrives within **90 s** of an
accepted remote-start, we treat the start as failed — void the hold, free the
connector claim, tell the driver to try another connector (matches
[SCREEN_FUNCTIONALITY.md](SCREEN_FUNCTIONALITY.md) S3 off-screen behavior).

## 4. Accuracy rules

1. **Bill the register delta.** `meterStop − meterStart`, in Wh, converted once to
   kWh (3 decimals internally, round the peso amount half-up at the end). Never bill
   the sample sum — samples can be lost, duplicated, or reordered without affecting
   the invoice.
2. **The live screen is an estimate and may lag.** Running ₱ on S4 comes from the
   latest sample register minus meterStart. Final receipt may differ slightly from
   the last thing the driver saw; that is correct behavior, and the receipt shows the
   authoritative math.
3. **Units paranoia.** OCPP energy is usually Wh but `unit` can say kWh — the
   normalizer must honor the reported unit, never assume.
4. **Idempotency.** `(csmsId, transactionId)` is unique on our sessions table;
   replayed `ended` events are no-ops; a `started` for an unknown sessionRef is
   alarmed, not billed (a session we didn't authorize should never energize).
5. **Offline chargers don't lose money.** OCPP charge points queue
   StopTransaction while offline and deliver on reconnect. Policy: session in
   `awaiting_final_meter` until the real stop arrives — capture waits (card holds
   live for days). Watchdog: if a session has had no samples for **10 min** AND the
   connector reports non-charging status, query the CSMS transaction endpoint; if
   still unresolved after **24 h**, close from the last known register, capture that
   amount (never more than observed), and flag for manual review. Undercharging on
   a gap is acceptable; overcharging is not.
6. **`PowerLoss` / `Faulted` stops** follow the same rule: bill only up to the last
   trustworthy register value.
7. **Clock skew:** durations shown to the driver use our receive-times; the
   meter math uses register values only, so skew never affects money.
8. **Metering class (regulatory):** DC chargers' internal meters must be
   billing-grade for ₱/kWh sale — confirm the fleet's meter certification and the
   ERC's current rules for EV charging resale in the PH. If a site can't bill by
   kWh legally, its tariff flips to per-minute (the tariff engine supports both).

## 5. Mapping to our modules and states

| Normalized event | Module reaction |
|---|---|
| `session_started` | sessions: `pending_start → charging`; store meterStart, transactionId; SSE "charging" to driver |
| `meter_sample` | sessions: update running kWh/₱ (bounded by 90%-of-hold soft-stop check); publish to Redis → SSE |
| `session_ended` | sessions: `charging → ended`; compute billed kWh & cost; payments: `AUTHORIZED → CAPTURING` with the exact amount; receipts issued on `CAPTURED` |
| `connector_status` | chargers: availability cache for S2/C2; watchdog input |
| (no start within 90 s) | payments: `AUTHORIZED → VOIDED`; driver returned to S2 |

## 6. Open questions for the CSMS team

1. Which OCPP versions are live across the fleet (1.6J vs 2.0.1 mix)?
2. Can remote-start carry our sessionRef through to the transaction (idTag /
   remoteStartId passthrough)?
3. Push events or polling only? Signed webhooks available? Ordering/at-least-once semantics?
4. Is there a transaction detail / replay endpoint for reconciliation?
5. Current `MeterValueSampleInterval` and sampled measurands across the fleet — is
   SoC reported on the DC chargers?
6. Who owns charger configuration changes (we need `StopTxnSampledData` to include
   the energy register)?
7. Meter certification class per charger model, for the ERC/billing question in §4.8.
