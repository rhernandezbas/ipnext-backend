import type { TvCredentialsReader, TvCredentials } from '@domain/ports/TvCredentialsReader';
import { ClientNotFoundError } from '@domain/errors';
import { TvNotLinkedError } from '@domain/errors/gigared';
import { currentTvInternalId } from '@domain/gigared/tvIdentity';
import type { CustomerLookup } from './lookups';

/**
 * GetTvCredentials (#65 fix wave H3) — the dedicated, permission-gated read of the TV
 * login/password. Replaces the leak where tvPassword rode out on GET /:id/contracts and on the
 * add/update service responses. Guarded by tv.register (same permission as changing the password).
 *
 * Guard order:
 *   0. customer must exist            → ClientNotFoundError (404)
 *   1. customer must have a TV row    → TvNotLinkedError (404) when the reader returns null
 */
export class GetTvCredentials {
  constructor(
    private readonly customerLookup: CustomerLookup,
    private readonly reader: TvCredentialsReader,
  ) {}

  async execute(customerId: string): Promise<TvCredentials> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    const credentials = await this.reader.getByCustomer(customerId);
    if (!credentials) throw new TvNotLinkedError(customerId);

    // #81 — el internal_id vigente lo computa el use case desde el seq del cliente (no el reader).
    // seq=0 → Client.id pelado (identidad de hoy). El FE lo muestra en Credenciales.
    const internalId = currentTvInternalId(customerId, customer.tvActivationSeq ?? 0);
    return { ...credentials, internalId };
  }
}
