import type { MessagingRatesConfigRepository, MessagingRatesConfig } from '@domain/ports/MessagingRatesConfigRepository';

/**
 * twilio-credit-guard (task 2.3/2.4, RATES-1) — molde `GetExternalBulkConfig`.
 * Delega íntegramente en el repo: los 5 defaults sin fila previa son
 * responsabilidad DEL REPO (mismo dato que siembra la migración), no de este
 * use case.
 */
export class GetMessagingRatesConfig {
  constructor(private readonly ratesRepo: MessagingRatesConfigRepository) {}

  async execute(): Promise<MessagingRatesConfig> {
    return this.ratesRepo.get();
  }
}
