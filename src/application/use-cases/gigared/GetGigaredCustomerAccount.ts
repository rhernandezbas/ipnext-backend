import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { ClientTvCancellationRepository } from '@domain/ports/ClientTvCancellationRepository';
import { GigaredNotFoundError } from '@domain/errors/gigared';
import { ClientNotFoundError } from '@domain/errors';
import type { CustomerLookup } from './lookups';

/**
 * GetGigaredCustomerAccount (#47 / #72) — fetch the Gigared account bound to this customer
 * (internal_id = customerId). A Gigared 404 is NOT an error here: it means "not linked",
 * mapped to { linked: false, account: null } (the FE shows the link/register forms).
 *
 * #72 — si el cliente tiene tvCancelledAt seteado (flag local "TV dada de baja"), devuelve
 * { linked: false, account: null } INMEDIATAMENTE, sin llamar al partner. El panel debe mostrar
 * "no vinculado" aunque el partner todavía resuelva por internal_id (el unlink del partner
 * nunca funcionó — HTTP 400 siempre). El flag local es la fuente de verdad para el panel.
 */
export class GetGigaredCustomerAccount {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly customerLookup: CustomerLookup,
    private readonly tvCancellation?: ClientTvCancellationRepository,
  ) {}

  async execute(customerId: string): Promise<{ linked: boolean; account: GigaredAccount | null }> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // #72 — flag local: si tvCancelledAt está seteado, el panel muestra "no vinculado"
    // sin consultar al partner (el partner lo seguiría resolviendo, pero el estado honesto es baja).
    if (this.tvCancellation && await this.tvCancellation.isCancelled(customerId)) {
      return { linked: false, account: null };
    }

    try {
      const account = await this.gigared.getAccountByInternalId(customerId);
      return { linked: true, account };
    } catch (e) {
      if (e instanceof GigaredNotFoundError) return { linked: false, account: null };
      throw e;
    }
  }
}
