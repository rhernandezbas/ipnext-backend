import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PortalMeDto } from '@application/dto/portal/portalMe.dto';

/**
 * GetPortalMe — customer-portal-api (Fase 4, task 4.1).
 *
 * portal-self-service spec "Mi resumen": el `clientId` SIEMPRE llega del token
 * (`req.portalClientId`, seteado por `portalAuthMiddleware`) — este use case no
 * acepta ni resuelve ningun otro origen (anti-IDOR estructural, spec "Anclaje al
 * cliente del token").
 */
export class GetPortalMe {
  constructor(private readonly customers: CustomerRepository) {}

  async execute(clientId: string): Promise<PortalMeDto> {
    const client = await this.customers.findById(clientId);
    return {
      name: client.name,
      status: client.status,
      // balanceDue === null (sin fetch de GR aun) se preserva TAL CUAL — jamas
      // se colapsa a 0 (spec "Cliente sin saldo fetcheado").
      balance: client.balanceDue ?? null,
      balanceCurrency: client.balanceCurrency ?? null,
      lastBalanceAt: client.lastBalanceAt ?? null,
    };
  }
}
