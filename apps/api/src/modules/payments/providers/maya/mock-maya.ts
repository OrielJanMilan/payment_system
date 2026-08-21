import { createHmac, randomUUID } from "node:crypto";
import { config } from "../../../../config.ts";
import type { CheckoutRequest, CheckoutResult, PaymentProvider } from "../provider.ts";

/* Mock Maya: stands in for Maya Checkout until real sandbox keys exist.
   Mimics the real integration shape — hosted page redirect, then an async
   HMAC-signed webhook to /webhooks/maya — so Phase 5's client code and the
   webhook module exercise the same paths the real provider will use.
   Checkout state is in-memory: dev-only, lost on restart, intents are not. */

export type MockCheckoutStatus =
  | "open"
  | "authorized"
  | "failed"
  | "expired"
  | "captured"
  | "voided";

export interface MockCheckout {
  id: string;
  intentId: string;
  amountCentavos: number;
  method: string;
  prepay: boolean;
  status: MockCheckoutStatus;
  successUrl: string;
  failureUrl: string;
  capturedCentavos: number | null;
  refundedCentavos: number | null;
}

const checkouts = new Map<string, MockCheckout>();

export function getMockCheckout(id: string): MockCheckout | undefined {
  return checkouts.get(id);
}

export const mockMaya: PaymentProvider = {
  name: "mock-maya",

  /* Per SCREEN_FUNCTIONALITY.md S3: QR Ph has no auth/capture hold —
     it falls back to prepay (charge now, refund unused). */
  supportsHold(method: string): boolean {
    return method !== "QR Ph";
  },

  createCheckout(request: CheckoutRequest): CheckoutResult {
    const id = "mchk_" + randomUUID().replaceAll("-", "").slice(0, 12);
    checkouts.set(id, {
      id,
      intentId: request.intentId,
      amountCentavos: request.amountCentavos,
      method: request.method,
      prepay: request.prepay,
      status: "open",
      successUrl: request.successUrl,
      failureUrl: request.failureUrl,
      capturedCentavos: null,
      refundedCentavos: null,
    });
    return { checkoutId: id, redirectUrl: `${config.baseUrl}/mock-maya/checkout/${id}` };
  },

  capture(checkoutId: string, amountCentavos: number): void {
    const c = mustGet(checkoutId);
    if (c.status !== "authorized") throw new Error(`cannot capture checkout in '${c.status}'`);
    if (amountCentavos > c.amountCentavos)
      throw new Error("capture exceeds authorized amount");
    c.status = "captured";
    c.capturedCentavos = amountCentavos;
  },

  voidHold(checkoutId: string): void {
    const c = mustGet(checkoutId);
    if (c.status !== "authorized") throw new Error(`cannot void checkout in '${c.status}'`);
    c.status = "voided";
  },

  refund(checkoutId: string, amountCentavos: number): void {
    const c = mustGet(checkoutId);
    if (c.status !== "captured") throw new Error(`cannot refund checkout in '${c.status}'`);
    c.refundedCentavos = (c.refundedCentavos ?? 0) + amountCentavos;
  },
};

function mustGet(id: string): MockCheckout {
  const c = checkouts.get(id);
  if (!c) throw new Error(`unknown mock checkout: ${id}`);
  return c;
}

/* Deliver a signed webhook to our own /webhooks/maya over real HTTP, exactly
   as the live provider would from outside. */
export async function fireWebhook(
  type: "payment.authorized" | "payment.failed" | "payment.expired",
  checkout: MockCheckout
): Promise<void> {
  const body = JSON.stringify({
    event_id: "evt_" + randomUUID().replaceAll("-", "").slice(0, 16),
    type,
    checkout_id: checkout.id,
    intent_id: checkout.intentId,
    amount_centavos: checkout.amountCentavos,
    created_at: new Date().toISOString(),
  });
  const signature = createHmac("sha256", config.mayaWebhookSecret).update(body).digest("hex");
  const response = await fetch(`${config.baseUrl}/webhooks/maya`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-maya-signature": signature },
    body,
  });
  if (!response.ok) console.error(`mock-maya webhook delivery failed: ${response.status}`);
}
