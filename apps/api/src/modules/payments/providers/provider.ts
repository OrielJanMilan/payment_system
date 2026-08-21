/* The provider seam (BACKEND.md §1): everything outside providers/ talks to
   this interface only. Swapping mock Maya for real Maya sandbox keys means
   registering a different implementation — nothing else changes. */

export interface CheckoutRequest {
  intentId: string;
  amountCentavos: number;
  method: string;
  prepay: boolean; // true → charge now, refund unused (methods without auth/capture)
  /* Public origin of the requesting client (derived per-request, so the same
     server works via localhost and a tunnel at once). */
  baseUrl: string;
  successUrl: string;
  failureUrl: string;
}

export interface CheckoutResult {
  checkoutId: string;
  redirectUrl: string; // the hosted checkout page the driver is sent to
}

export interface PaymentProvider {
  readonly name: string;
  /* Whether this method supports an auth/capture hold; false → prepay fallback. */
  supportsHold(method: string): boolean;
  createCheckout(request: CheckoutRequest): CheckoutResult;
  capture(checkoutId: string, amountCentavos: number): void;
  voidHold(checkoutId: string): void;
  refund(checkoutId: string, amountCentavos: number): void;
}

const providers = new Map<string, PaymentProvider>();

export function registerProvider(provider: PaymentProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): PaymentProvider {
  const provider = providers.get(name);
  if (!provider) throw new Error(`payment provider not registered: ${name}`);
  return provider;
}
