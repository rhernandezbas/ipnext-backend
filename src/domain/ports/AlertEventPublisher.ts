import { NocAlert } from '@domain/entities/nocAlert';

export type NocAlertEventType = 'firing' | 'resolved' | 'acked';

export interface NocAlertEvent {
  type: NocAlertEventType;
  alert: NocAlert;
}

/**
 * AlertEventPublisher — fan-out port published by use-cases AFTER a successful
 * persist. `AlertEventBus` (infra, Fase C) implements it over an in-memory
 * EventEmitter for SSE. Fase A only defines the port + wires a no-op fake so
 * ingestion stays dark (no listeners subscribed yet).
 */
export interface AlertEventPublisher {
  publish(event: NocAlertEvent): void;
}
