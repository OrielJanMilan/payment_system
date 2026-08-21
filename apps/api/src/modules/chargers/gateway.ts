import { db, nowIso } from "../../db/db.ts";
import { config } from "../../config.ts";
import * as sessions from "../sessions/service.ts";
import { publish } from "../sessions/events.ts";
import { paymentsBus, captureForSession, voidForSession } from "../payments/service.ts";
import { MockChargePoint, type NormalizedEvent } from "./mock-cp.ts";

/* Charger gateway: consumes the normalized event set and drives sessions +
   payments (Charging_Synchronization.md §5). When the real CSMS/OCPP link
   arrives, its adapter feeds handleEvent() and remote-start/stop swap their
   implementations — nothing else changes. */

let cp: MockChargePoint | null = null;

export function initChargerGateway(): MockChargePoint {
  if (cp) return cp;
  cp = new MockChargePoint(handleEvent);
  /* Payment authorized → energize (S3 off-screen behavior). */
  paymentsBus.on("authorized", ({ sessionId }: { sessionId: string }) => startCharger(sessionId));
  return cp;
}

export function chargePoint(): MockChargePoint {
  if (!cp) throw new Error("charger gateway not initialized");
  return cp;
}

/* THE billing rule: register delta × pinned tariff, peso rounded half-up at
   the end. Samples never feed this. */
export function amountForWh(wh: number, tariffCentavosPerKwh: number): number {
  return Math.round((wh * tariffCentavosPerKwh) / 1000);
}

interface ChargingRow {
  id: string;
  meter_start_wh: number;
  tariff_centavos_per_kwh: number;
  hold_centavos: number;
}

function chargingByTransaction(transactionId: string): ChargingRow | undefined {
  return db
    .prepare(
      `SELECT id, meter_start_wh, tariff_centavos_per_kwh, hold_centavos
       FROM sessions WHERE transaction_id = ? AND state = 'charging'`
    )
    .get(transactionId) as ChargingRow | undefined;
}

function handleEvent(event: NormalizedEvent): void {
  switch (event.kind) {
    case "session_started": {
      /* A start we didn't authorize must never be billed (accuracy rule 4). */
      const moved = sessions.transition(event.sessionRef, "charging", {
        transaction_id: event.transactionId,
        meter_start_wh: event.meterStartWh,
        started_at: event.at,
      });
      if (!moved)
        console.error(`ALARM: session_started for unknown/unauthorized sessionRef ${event.sessionRef} — not billing`);
      break;
    }

    case "meter_sample": {
      const s = chargingByTransaction(event.transactionId);
      if (!s) break; // sample for a session we don't consider live — ignore
      const runningWh = event.registerWh - s.meter_start_wh;
      publish(s.id, {
        type: "meter",
        energyWh: runningWh,
        powerKw: event.powerKw,
        soc: event.soc,
        at: event.at,
      });
      /* Soft-stop before the running cost can exceed the authorization. */
      const runningCost = amountForWh(runningWh, s.tariff_centavos_per_kwh);
      if (runningCost >= s.hold_centavos * config.softStopFraction) {
        cp?.remoteStop(event.transactionId);
      }
      break;
    }

    case "session_ended": {
      const s = chargingByTransaction(event.transactionId);
      if (!s) break; // replay of an already-ended transaction — no-op
      const billedWh = event.meterStopWh - s.meter_start_wh;
      let amount = amountForWh(billedWh, s.tariff_centavos_per_kwh);
      if (amount > s.hold_centavos) {
        console.error(`ALARM: session ${s.id} billed ${amount} above hold ${s.hold_centavos} — clamping`);
        amount = s.hold_centavos;
      }
      sessions.transition(s.id, "ended", {
        meter_stop_wh: event.meterStopWh,
        billed_wh: billedWh,
        amount_centavos: amount,
        stop_reason: event.reason,
        ended_at: event.at,
      });
      captureForSession(s.id, amount);
      break;
    }

    case "connector_status": {
      db.prepare("UPDATE connectors SET status = ? WHERE id = ?").run(
        event.status,
        event.connectorId
      );
      break;
    }
  }
}

function startCharger(sessionId: string): void {
  const session = sessions.getSession(sessionId);
  if (!session || session.state !== "pending_start" || !cp) return;

  const result = cp.remoteStart(session.connectorId, sessionId);
  if (result === "Rejected") {
    failStart(sessionId);
    return;
  }
  /* Accepted ≠ started: watchdog voids the hold if no session_started lands. */
  setTimeout(() => {
    const current = sessions.getSession(sessionId);
    if (current?.state === "pending_start") failStart(sessionId);
  }, config.startTimeoutMs);
}

function failStart(sessionId: string): void {
  voidForSession(sessionId);
  sessions.transition(sessionId, "start_failed"); // releases the connector, notifies SSE
}

/* Driver taps Stop (S4) — or any server-side stop trigger. */
export function requestStop(sessionId: string): "ok" | "not_charging" {
  const row = db
    .prepare("SELECT transaction_id FROM sessions WHERE id = ? AND state = 'charging'")
    .get(sessionId) as { transaction_id: string | null } | undefined;
  if (!row?.transaction_id || !cp) return "not_charging";
  cp.remoteStop(row.transaction_id);
  return "ok";
}
