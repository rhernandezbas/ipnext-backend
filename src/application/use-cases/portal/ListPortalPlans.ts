import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PortalPlanDto } from '@application/dto/portal/portalPlan.dto';

/**
 * ListPortalPlans — customer-portal-api (Fase 4, task 4.3).
 *
 * portal-self-service spec "Mis planes": reusa `CustomerRepository.listContracts`
 * (el mismo port que `GetClientContracts`, ya usado por el admin) — un `Contract`
 * trae `services[]` eager-loaded (#43, sin N+1). `clientId` SIEMPRE del token.
 */
export class ListPortalPlans {
  constructor(private readonly customers: CustomerRepository) {}

  async execute(clientId: string): Promise<PortalPlanDto[]> {
    const contracts = await this.customers.listContracts(clientId);
    // L1 (fix wave): SIN contractId — el id interno del contrato no esta en el
    // allow-list del spec y no se filtra al portal.
    return contracts.map((c) => ({
      plan: c.plan,
      type: c.type,
      status: c.status,
      startDate: c.startDate,
      services: c.services.map((s) => ({ name: s.name, status: s.status })),
    }));
  }
}
