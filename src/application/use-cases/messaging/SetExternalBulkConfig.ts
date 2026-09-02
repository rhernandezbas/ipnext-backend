import type {
  ExternalBulkMessagingConfigRepository,
  ExternalBulkMessagingConfig,
} from '@domain/ports/ExternalBulkMessagingConfigRepository';
import { ExternalBulkValidationError } from '@domain/errors/external-bulk-messaging';
import { MAX_MANUAL_CONTACTS } from './resolveCombinedRecipients';

/**
 * `maxPerRequest`/`maxPerDay` llegan tipados `unknown` a propósito: este use
 * case es la ÚLTIMA barrera de tipo antes de tocar el repo. La ruta HTTP
 * (task 4.4) pasa `req.body` casteado a `Record<string, unknown>` SIN validar
 * con zod — evita duplicar la MISMA regla en dos capas (mismo criterio que
 * `SendExternalBulk`'s "forma del input" check, molde `ExternalBulkValidationError`).
 */
export interface SetExternalBulkConfigInput {
  maxPerRequest: unknown;
  maxPerDay: unknown;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * external-bulk-messaging (task 4.1, CONFIG-3) — escritura de los topes.
 * Rechaza valores no-entero-positivos y `maxPerRequest > maxPerDay` SIN tocar
 * el repo (config-3: "la config NO se persiste"); `maxPerRequest === maxPerDay`
 * SÍ es válido (un solo request puede agotar el día entero, no es "exceder").
 */
export class SetExternalBulkConfig {
  constructor(private readonly configRepo: ExternalBulkMessagingConfigRepository) {}

  async execute(input: SetExternalBulkConfigInput): Promise<ExternalBulkMessagingConfig> {
    if (!isPositiveInteger(input.maxPerRequest) || !isPositiveInteger(input.maxPerDay)) {
      throw new ExternalBulkValidationError('maxPerRequest and maxPerDay must be positive integers');
    }
    if (input.maxPerRequest > input.maxPerDay) {
      throw new ExternalBulkValidationError('maxPerRequest cannot exceed maxPerDay');
    }
    // fix wave F1 (F4) — techo DURO contra la cota del motor de envío.
    // `resolveCombinedRecipients` tira `TooManyManualContactsError` (422) por
    // encima de `MAX_MANUAL_CONTACTS`, y el `send` externo pasa TODO el preview
    // como `manualContacts`. Sin este techo, un `maxPerRequest` mayor deja al
    // sistema prometiendo en `validate` (200 + preview persistido) un lote que
    // el `send` NUNCA va a poder despachar — 422 eterno sobre un preview válido.
    // El techo se valida ACÁ (una sola vez, al escribir) en vez de en cada
    // request.
    if (input.maxPerRequest > MAX_MANUAL_CONTACTS) {
      throw new ExternalBulkValidationError(
        `maxPerRequest cannot exceed ${MAX_MANUAL_CONTACTS} (hard cap of the bulk send engine)`,
      );
    }
    return this.configRepo.set({ maxPerRequest: input.maxPerRequest, maxPerDay: input.maxPerDay });
  }
}
