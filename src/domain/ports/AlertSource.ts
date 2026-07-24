import { NocAlertInput } from '@domain/entities/nocAlert';

/**
 * AlertSource — maps a fuente-specific raw payload into the canonical `NocAlertInput`.
 * Fase A defines only the port; `GrafanaWebhookSource` (Fase B) is the first impl.
 */
export interface AlertSource {
  map(raw: unknown): NocAlertInput;
}
