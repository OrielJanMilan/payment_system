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
