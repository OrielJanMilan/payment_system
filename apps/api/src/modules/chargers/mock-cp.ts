import { randomUUID } from "node:crypto";
import { config } from "../../config.ts";

/* Virtual charge point: stands in for the real charger + CSMS link until the
   OCPP/CSMS integration exists. It speaks the NORMALIZED event set from
   Charging_Synchronization.md §1 (adapter note), which is exactly what a real
   OCPP 1.6J/2.0.1 adapter must emit — so the gateway consuming these events
   never knows it's talking to a simulation.

   Faithful behaviors: a real monotonic meter register (Wh) that is the only
   source of billing truth, remote-start carrying our sessionRef (the idTag
   trick), spin-up delay before StartTransaction, sample emission while
   charging, stop reasons, and offline queueing of the end event. */

export type NormalizedEvent =
  | { kind: "session_started"; sessionRef: string; transactionId: string; meterStartWh: number; at: string }
  | { kind: "meter_sample"; transactionId: string; registerWh: number; powerKw: number; soc: number | null; at: string }
  | { kind: "session_ended"; transactionId: string; meterStopWh: number; reason: string; at: string }
  | { kind: "connector_status"; connectorId: number; status: "AVAILABLE" | "IN_USE" | "OFFLINE"; at: string };

export type StartBehavior = "normal" | "reject" | "silent";

interface ActiveTx {
  id: string;
  sessionRef: string;
  soc: number;
  powerKw: number;
}

export class MockChargePoint {
  readonly connectorId = 1; // matches the seeded connector
  registerWh = 1_204_320; // meters never reset — monotonic across sessions
  online = true;
  /* Applies to the NEXT remote-start, then resets:
     reject → .conf Rejected; silent → Accepted but no StartTransaction ever
     (exercises the 90 s watchdog). */
  startBehavior: StartBehavior = "normal";

  private tx: ActiveTx | null = null;
  private sampleTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private pendingEnd: NormalizedEvent | null = null; // queued while offline

  constructor(private readonly emit: (event: NormalizedEvent) => void) {}

  snapshot() {
    return {
      online: this.online,
      registerWh: this.registerWh,
      startBehavior: this.startBehavior,
      transaction: this.tx
        ? { id: this.tx.id, sessionRef: this.tx.sessionRef, soc: Math.round(this.tx.soc), powerKw: Math.round(this.tx.powerKw) }
        : null,
      queuedEndEvent: this.pendingEnd !== null,
    };
  }

  /* `.conf Accepted` only means the charger will try (Charging_Synchronization.md §1). */
  remoteStart(connectorId: number, sessionRef: string): "Accepted" | "Rejected" {
    if (!this.online || this.tx || connectorId !== this.connectorId) return "Rejected";
    const behavior = this.startBehavior;
    this.startBehavior = "normal";
    if (behavior === "reject") return "Rejected";
    if (behavior === "silent") return "Accepted"; // never starts — watchdog must fire
    this.startTimer = setTimeout(() => this.beginTransaction(sessionRef), config.mockCp.startDelayMs);
    return "Accepted";
  }

  remoteStop(transactionId: string): boolean {
    if (!this.tx || this.tx.id !== transactionId) return false;
    this.end("Remote");
    return true;
  }

  /* Scenario triggers (control panel) */
  unplug(): boolean {
    if (!this.tx) return false;
    this.end("EVDisconnected");
    return true;
  }
  vehicleFull(): boolean {
    if (!this.tx) return false;
    this.end("EVFull");
    return true;
  }
  /* Site power fails: session ends at the last trustworthy register value and
     the end event is delivered when the charger reconnects (accuracy rule 5/6). */
  powerLoss(): boolean {
    if (!this.tx) return false;
    this.setOnline(false);
    this.end("PowerLoss");
    return true;
  }

  setOnline(online: boolean): void {
    if (online === this.online) return;
    if (!online) {
      this.online = false; // CSMS notices the socket drop → OFFLINE
      this.send({ kind: "connector_status", connectorId: this.connectorId, status: "OFFLINE", at: now() }, true);
    } else {
      this.online = true;
      if (this.pendingEnd) {
        const queued = this.pendingEnd;
        this.pendingEnd = null;
        this.send(queued);
        this.send({ kind: "connector_status", connectorId: this.connectorId, status: "AVAILABLE", at: now() });
      } else {
        this.send({
          kind: "connector_status",
          connectorId: this.connectorId,
          status: this.tx ? "IN_USE" : "AVAILABLE",
          at: now(),
        });
      }
    }
  }

  private beginTransaction(sessionRef: string): void {
    this.tx = { id: "tx_" + randomUUID().replaceAll("-", "").slice(0, 10), sessionRef, soc: 42, powerKw: 47 };
    this.send({ kind: "connector_status", connectorId: this.connectorId, status: "IN_USE", at: now() });
    this.send({
      kind: "session_started",
      sessionRef,
      transactionId: this.tx.id,
      meterStartWh: this.registerWh,
      at: now(),
    });
    this.sampleTimer = setInterval(() => this.sample(), config.mockCp.sampleIntervalMs);
  }

  private sample(): void {
    if (!this.tx) return;
    this.tx.powerKw = 44 + Math.random() * 8;
    const hours = (config.mockCp.sampleIntervalMs / 3_600_000) * config.mockCp.accel;
    this.registerWh += Math.round(this.tx.powerKw * 1000 * hours);
    this.tx.soc = Math.min(100, this.tx.soc + 0.09 * config.mockCp.accel * (config.mockCp.sampleIntervalMs / 3000));
    if (this.online) {
      this.send({
        kind: "meter_sample",
        transactionId: this.tx.id,
        registerWh: this.registerWh,
        powerKw: this.tx.powerKw,
        soc: Math.round(this.tx.soc),
        at: now(),
      });
    }
    /* The emit can end the transaction reentrantly (gateway soft-stop calls
       remoteStop synchronously) — re-check before the vehicle-full check. */
    if (this.tx && this.tx.soc >= 100) this.end("EVFull");
  }

  private end(reason: string): void {
    if (!this.tx) return;
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.sampleTimer = null;
    this.startTimer = null;
    const event: NormalizedEvent = {
      kind: "session_ended",
      transactionId: this.tx.id,
      meterStopWh: this.registerWh,
      reason,
      at: now(),
    };
    this.tx = null;
    if (this.online) {
      this.send(event);
      this.send({ kind: "connector_status", connectorId: this.connectorId, status: "AVAILABLE", at: now() });
    } else {
      this.pendingEnd = event; // delivered on reconnect
    }
  }

  private send(event: NormalizedEvent, force = false): void {
    if (this.online || force) this.emit(event);
  }
}

function now(): string {
  return new Date().toISOString();
}
