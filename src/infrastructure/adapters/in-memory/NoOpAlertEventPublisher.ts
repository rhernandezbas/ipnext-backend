import { AlertEventPublisher, NocAlertEvent } from '@domain/ports/AlertEventPublisher';

/**
 * NoOpAlertEventPublisher — fake used in tests (and as the Fase A composition-root
 * default until `AlertEventBus`/SSE lands in Fase C) so `IngestAlert`/`AcknowledgeAlert`
 * can publish without any real subscriber wired.
 */
export class NoOpAlertEventPublisher implements AlertEventPublisher {
  readonly published: NocAlertEvent[] = [];

  publish(event: NocAlertEvent): void {
    this.published.push(event);
  }
}
