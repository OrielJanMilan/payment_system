# Issue Tracker

Known issues found during testing, tracked until fixed. When a fix lands and is
verified, mark it ✅ fixed with the commit hash. Newest issues at the bottom.

Legend: 🔴 open · 🟡 in progress · ✅ fixed

---

## #1 ✅ Re-scanning the QR mid-charge does not return to the Live screen

**Reported:** Aug 21, 2026 (phone testing)

**Steps to reproduce:** start a charging session → close the browser/app while
charging → scan the charger QR code again.

**Expected:** the app recognizes the still-active session and lands on the Live
screen at the current charge state (₱ so far, kWh, battery %) — per
SCREEN_FUNCTIONALITY.md global behavior: "Reopening the app while a session is
`charging` routes straight to S4."

**Actual:** the QR deep link (`/c/{slug}`) lands on the Start screen for the
charger as if beginning a new session; the driver's own live session is
ignored (and the connector shows "in use" — held by their own session).

**Root cause:** in `apps/web/app.js` `boot()`, the `?c={slug}` deep-link branch
runs **before** the `activeSessionId` resume branch, so a scan always wins over
an active session. The session state itself is safe on the server — only the
client routing is wrong.

**Proposed fix:** reorder `boot()` — resolve the active session first; if its
state is `charging` / `pending_start`, route to Live regardless of how the app
was opened (deep link, bare URL, or code entry). The deep link only proceeds to
Start when there is no live session.

---

## #2 ✅ Charging finished while app was closed — receipt never shown

**Reported:** Aug 21, 2026 (phone testing)

**Steps to reproduce:** start a session → close the browser/app → let charging
finish (driver stop from another device, soft-stop, unplug, vehicle full) →
reopen the app (scan or direct).

**Expected:** the app opens on the Receipt page for the completed session (the
capture already happened server-side), until the driver taps **Done**.

**Actual:** `boot()`'s resume branch sees the session is `ended`, silently
clears the stored session pointer, and lands on the Scan screen. The driver
never sees what they were charged unless they dig into History.

**Root cause:** `apps/web/app.js` `boot()` treats any non-live resumed session
as stale and discards it. There is no "ended but not yet acknowledged" state on
the client.

**Proposed fix:** when the resumed session is `ended`, render the Receipt from
the server data and keep `activeSessionId` until the driver taps **Done**
(which already clears it). Applies to `start_failed` too — show the
"hold released" explanation instead of dropping to Scan silently.

---

## #3 ✅ Closing the app mid-payment loses the retryable session (minor)

**Reported:** Aug 21, 2026 (found during development, same family as #1/#2)

**Steps to reproduce:** tap "Hold & start" → reach the hosted checkout → close
the browser without completing → reopen the app within the 10-minute TTL.

**Expected:** the app restores the pending session ("reserved for you") so the
driver can retry payment on the connector they still hold.

**Actual:** the in-memory `pendingSession` is lost on reload; the Start screen
shows the connector as "in use" (blocked by the driver's own claim) until the
10-minute TTL expires it.

**Root cause:** retry-session state lives only in a JS variable; `boot()`
resume only handles `charging`/`pending_start`, not `pending_payment`.

**Proposed fix:** in the resume branch, a `pending_payment` session that is
still inside its TTL restores `pendingSession` + charger and lands on Start
with the "reserved for you" state and payment methods enabled.

---

*#1–#3 fixed in `60a108b` (Aug 21, 2026): `boot()` now resolves the driver's
own session before honoring a deep link — charging → Live, ended → Receipt
(until Done; a scanned slug continues to that charger after Done),
pending_payment in TTL → Start with the reservation restored, start_failed →
one-time "hold released" notice. Verified in-browser across all four resume
states plus fresh-user regression.*
