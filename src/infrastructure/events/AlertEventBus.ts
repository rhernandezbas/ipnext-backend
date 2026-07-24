import { EventEmitter } from 'events';
import { AlertEventPublisher, NocAlertEvent } from '@domain/ports/AlertEventPublisher';

/** Internal channel name — a private implementation detail, never exposed. */
const CHANNEL = 'noc-alert-event';

/**
 * AlertEventBus — infra adapter (`noc-alert-realtime`, Fase C) implementing the
 * `AlertEventPublisher` port over a real Node `EventEmitter`. `IngestAlert`/
 * `AcknowledgeAlert` publish to it (via the port, DIP-clean); `GET /api/alerts/stream`
 * (alerts.routes.ts) subscribes to THIS concrete class directly — the route
 * needs `subscribe`, which isn't part of the port (design.md "la ruta SSE se
 * suscribe al bus, NUNCA al use-case").
 *
 * SAFE SINGLE-INSTANCE ONLY: design.md "Decision: Real-time por SSE +
 * event-bus in-memory" verified `deploy.yml` runs one replica (no scale-out) —
 * an in-memory bus is fine today. If replicas are ever added, this needs to
 * move to Redis pub/sub or Postgres LISTEN/NOTIFY (documented invariant, not
 * re-litigated here).
 */
export class AlertEventBus implements AlertEventPublisher {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Unbounded — an arbitrary number of NOC operators can have the panel open
    // (one SSE connection = one listener). Node's default cap of 10 would spam
    // stderr with MaxListenersExceededWarning under completely normal usage.
    this.emitter.setMaxListeners(0);
  }

  /**
   * F-C2 (fix wave, MEDIUM) — NUNCA usar `emitter.emit(...)` a pelo acá: si un
   * listener tira (ej. `res.write` sobre un socket SSE ya destruido), Node
   * propaga la excepción sincrónicamente desde `emit()` — eso mata el fan-out
   * para los subscribers SIGUIENTES y hace que `publish()` propague hacia el
   * caller (`IngestAlert`/`AcknowledgeAlert`), devolviendo un 500 aunque el
   * persist ya se completó OK. Iterar los listeners a mano con try/catch POR
   * listener aísla cada uno: uno que tira no afecta a los demás ni a quien
   * llamó a `publish()`. El error se loguea (no se re-lanza).
   */
  publish(event: NocAlertEvent): void {
    const listeners = this.emitter.listeners(CHANNEL) as Array<(event: NocAlertEvent) => void>;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[AlertEventBus] subscriber lanzó al procesar un evento — aislado, no afecta a los demás', err);
      }
    }
  }

  /**
   * Subscribes `listener` to every published event. Returns an unsubscribe
   * function — the SSE route calls it from `req.on('close')` so a disconnected
   * client never leaves a dangling listener behind (C13 — memory-leak guard).
   */
  subscribe(listener: (event: NocAlertEvent) => void): () => void {
    this.emitter.on(CHANNEL, listener);
    return () => {
      this.emitter.off(CHANNEL, listener);
    };
  }

  /** Test/observability seam — how many listeners are currently subscribed. */
  listenerCount(): number {
    return this.emitter.listenerCount(CHANNEL);
  }
}
