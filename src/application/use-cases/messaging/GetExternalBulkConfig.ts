import type {
  ExternalBulkMessagingConfigRepository,
  ExternalBulkMessagingConfig,
} from '@domain/ports/ExternalBulkMessagingConfigRepository';

/**
 * external-bulk-messaging (task 4.1, CONFIG-1) — lectura de los topes
 * editables (`maxPerRequest`/`maxPerDay`). Delega íntegramente en el repo: los
 * defaults 500/2000 sin fila previa son responsabilidad DEL REPO (mismo dato
 * que siembra la migración), no de este use case.
 */
export class GetExternalBulkConfig {
  constructor(private readonly configRepo: ExternalBulkMessagingConfigRepository) {}

  async execute(): Promise<ExternalBulkMessagingConfig> {
    return this.configRepo.get();
  }
}
