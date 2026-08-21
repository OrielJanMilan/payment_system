/* DTOs shared between apps/api and apps/web.
   Money is always integer centavos; energy is integer watt-hours.
   Conversions to ₱ / kWh happen only at the display edge. */

export type ConnectorStatus = "AVAILABLE" | "IN_USE" | "OFFLINE";

export type SessionState =
  | "pending_payment"
  | "pending_start"
  | "charging"
  | "ended"
  | "expired"
  | "start_failed";

export type PaymentIntentState =
  | "CREATED"
  | "PENDING_AUTH"
  | "AUTHORIZED"
  | "CAPTURING"
  | "CAPTURED"
  | "AUTH_FAILED"
  | "EXPIRED"
  | "VOIDED"
  | "REFUNDED";

export interface ChargerDto {
  code: string;
  qrSlug: string;
  siteName: string;
  bay: string;
  connectors: ConnectorDto[];
  tariffCentavosPerKwh: number;
  holdCentavos: number;
}

export interface ConnectorDto {
  id: number;
  type: string;
  maxKw: number;
  status: ConnectorStatus;
}

export interface SessionDto {
  id: string;
  state: SessionState;
  chargerCode: string;
  siteName: string;
  bay: string;
  connectorId: number;
  tariffCentavosPerKwh: number;
  holdCentavos: number;
  createdAt: string;
  expiresAt: string;
  startedAt: string | null;
  endedAt: string | null;
  meterStartWh: number | null;
  meterStopWh: number | null;
  billedWh: number | null;
  amountCentavos: number | null;
  receiptNo: string | null;
  stopReason: string | null;
}

export interface PaymentIntentDto {
  id: string;
  sessionId: string;
  provider: string;
  state: PaymentIntentState;
  method: string | null;
  prepay: boolean;
  holdCentavos: number;
  capturedCentavos: number | null;
  createdAt: string;
  updatedAt: string;
}

/* Envelope streamed over GET /sessions/{id}/events (SSE). */
export type SessionEvent =
  | { type: "state"; state: SessionState; session: SessionDto }
  | { type: "meter"; energyWh: number; powerKw: number; soc: number | null; at: string };
