import { EventEmitter } from "node:events";
import type { SessionEvent } from "@payment-system/shared";

/* In-process pub/sub keyed by session id — the seam where Redis pub/sub
   slots in when this runs on more than one instance. */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(sessionId: string, event: SessionEvent): void {
  bus.emit(sessionId, event);
}

export function subscribe(
  sessionId: string,
  listener: (event: SessionEvent) => void
): () => void {
  bus.on(sessionId, listener);
  return () => bus.off(sessionId, listener);
}
