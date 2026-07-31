/**
 * customer-portal-api (Fase 5, task 5.1 + fix wave C3 + v2.A portal-ticket-contract) — GetPortalTicket.
 *
 * C3: el detalle se resuelve por `sequenceNumber` (el `number` que SI viaja en
 * los DTOs de lista/creacion), NUNCA por el UUID interno — los DTOs del portal
 * no exponen `id` a proposito, asi que resolver por UUID dejaba la ruta
 * inalcanzable para la app.
 *
 * portal-self-service spec "Ticket ajeno por id": 404 IDENTICO para "no existe"
 * y "es de otro cliente" — este test prueba que el use case devuelve `null` en
 * AMBOS casos (la ruta es la que decide el 404, pero el use case no debe filtrar
 * la diferencia via ningun otro medio, p.ej. lanzando errores distintos).
 *
 * v2.A — `contractId`/`contractLabel` en el detalle (ver doc de
 * PortalTicketDetailDto). `CustomerRepository` no tiene adapter in-memory en
 * este repo (convención existente — ver ListPortalPlans.test.ts): se usa un
 * fake narrow (`Pick<CustomerRepository, 'listContracts'>`).
 */
import { GetPortalTicket } from '@application/use-cases/portal/GetPortalTicket';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';

function makeContract(overrides: Partial<Contract> & { id: string }): Contract {
  return {
    code: null,
    type: 'internet',
    plan: '50 Mb Simetrico',
    ip: '10.0.0.1',
    status: 'active',
    startDate: '2025-01-01T00:00:00.000Z',
    endDate: '',
    address: null,
    lat: null,
    lng: null,
    technology: null,
    name: null,
    vendedor: null,
    services: [],
    ...overrides,
  };
}

const NO_CONTRACTS: Pick<CustomerRepository, 'listContracts'> = { listContracts: async () => [] };

describe('GetPortalTicket — customer-portal-api Fase 5.1 (C3: lookup por sequenceNumber)', () => {
  it('devuelve el detalle SIN comentarios cuando el ticket es del cliente, buscado por su number', async () => {
    const repo = new InMemoryTicketRepository();
    const ticket = await repo.create({ subject: 'No anda internet', description: 'desde ayer', customerId: 'client-a' });
    const useCase = new GetPortalTicket(repo, NO_CONTRACTS);

    const result = await useCase.execute('client-a', ticket.sequenceNumber);

    expect(result).toEqual({
      number: ticket.sequenceNumber,
      subject: 'No anda internet',
      description: 'desde ayer',
      status: 'open',
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      contractId: null,
      contractLabel: null,
    });
    expect((result as unknown as Record<string, unknown>)['comments']).toBeUndefined();
    // El DTO jamas filtra el UUID interno.
    expect((result as unknown as Record<string, unknown>)['id']).toBeUndefined();
  });

  it('number inexistente -> null', async () => {
    const repo = new InMemoryTicketRepository();
    const useCase = new GetPortalTicket(repo, NO_CONTRACTS);

    const result = await useCase.execute('client-a', 999_999);

    expect(result).toBeNull();
  });

  it('anti-IDOR (scenario "Ticket ajeno por id"): number de OTRO cliente -> null, IGUAL que inexistente', async () => {
    const repo = new InMemoryTicketRepository();
    const ticketB = await repo.create({ subject: 'Ticket de B', description: 'd', customerId: 'client-b' });
    const useCase = new GetPortalTicket(repo, NO_CONTRACTS);

    const resultForForeignTicket = await useCase.execute('client-a', ticketB.sequenceNumber);
    const resultForMissingTicket = await useCase.execute('client-a', 999_999);

    expect(resultForForeignTicket).toBeNull();
    expect(resultForForeignTicket).toEqual(resultForMissingTicket);
  });

  describe('v2.A (portal-ticket-contract) — contractId/contractLabel en el detalle', () => {
    it('ticket creado con contrato -> expone contractId + contractLabel (Contract.plan) legible', async () => {
      const repo = new InMemoryTicketRepository();
      const ticket = await repo.create({ subject: 'No anda', description: 'd', customerId: 'client-a', contractId: 'contract-a1' });
      const customers: Pick<CustomerRepository, 'listContracts'> = {
        listContracts: async (clientId) => (clientId === 'client-a' ? [makeContract({ id: 'contract-a1', plan: '50 Mb Simetrico' })] : []),
      };
      const useCase = new GetPortalTicket(repo, customers);

      const result = await useCase.execute('client-a', ticket.sequenceNumber);

      expect(result?.contractId).toBe('contract-a1');
      expect(result?.contractLabel).toBe('50 Mb Simetrico');
    });

    it('ticket con contractId que ya no aparece en los contratos del cliente -> contractLabel null, no rompe', async () => {
      const repo = new InMemoryTicketRepository();
      const ticket = await repo.create({ subject: 'No anda', description: 'd', customerId: 'client-a', contractId: 'contract-borrado' });
      const useCase = new GetPortalTicket(repo, NO_CONTRACTS);

      const result = await useCase.execute('client-a', ticket.sequenceNumber);

      expect(result?.contractId).toBe('contract-borrado');
      expect(result?.contractLabel).toBeNull();
    });
  });
});
