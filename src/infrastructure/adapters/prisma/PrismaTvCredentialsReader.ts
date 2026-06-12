import type { TvCredentialsReader, TvCredentials } from '@domain/ports/TvCredentialsReader';
import { prisma } from '../../database/prisma';

/**
 * #65 fix wave H3 — reads the TV credentials of a customer from the Gigared-managed TV
 * ContractService row. Joins contractService → contract (clientId) → serviceCatalog (name = 'TV').
 *
 * STATUS-AGNOSTIC by design: the credentials must survive an INACTIVE row (M8 — a rebaja leaves the
 * row inactive but the operator still needs to read them; a baja explicitly NULLs them, M6). When
 * the customer has more than one contract, the most recently created TV row wins. Returns null when
 * the customer has no TV row at all (the use case maps that to TV_NOT_LINKED 404).
 */
export class PrismaTvCredentialsReader implements TvCredentialsReader {
  async getByCustomer(customerId: string): Promise<TvCredentials | null> {
    const row = await (prisma as any).contractService.findFirst({
      where: {
        serviceCatalog: { is: { name: 'TV' } },
        contract: { is: { clientId: customerId } },
      },
      orderBy: { createdAt: 'desc' },
      select: { tvLogin: true, tvPassword: true },
    });
    if (!row) return null;
    return { login: row.tvLogin ?? null, password: row.tvPassword ?? null };
  }
}
