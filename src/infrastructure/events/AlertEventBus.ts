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

  publish(event: NocAlertEvent): void {
    this.emitter.emit(CHANNEL, event);
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
