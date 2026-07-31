/**
 * customer-portal-api (Fase 5, task 5.2) — CreatePortalTicket.
 *
 * portal-self-service spec "Cliente crea un reclamo" + "Payload inválido".
 * Usa InMemoryTicketRepository + InMemoryTicketAreaCatalogRepository (adapters
 * reales, compartidos con el admin).
 *
 * v2.A (portal-ticket-contract) — "para abrir un reclamo debería seleccionar
 * el contrato primero". `CustomerRepository` no tiene adapter in-memory en
 * este repo (convención existente — ver ListPortalPlans.test.ts): se usa un
 * fake narrow (`Pick<CustomerRepository, 'listContracts'>`, mismo tipo que
 * pide el constructor de CreatePortalTicket).
 */
import { CreatePortalTicket, PORTAL_TICKET_SUBJECT_MAX_LEN, PORTAL_TICKET_DESCRIPTION_MAX_LEN } from '@application/use-cases/portal/CreatePortalTicket';
import { PortalTicketValidationError, PortalContractRequiredError, PortalContractNotFoundError } from '@domain/errors/portal.errors';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
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

/** Fake narrow — mismo tipo que consume el constructor (`Pick<CustomerRepository, 'listContracts'>`). */
function fakeCustomers(byClient: Record<string, Contract[]>): Pick<CustomerRepository, 'listContracts'> {
  return {
    listContracts: async (clientId: string) => byClient[clientId] ?? [],
  };
}

const NO_CONTRACTS = fakeCustomers({});

describe('CreatePortalTicket — customer-portal-api Fase 5.2', () => {
  it('scenario "Cliente crea un reclamo": crea el ticket asociado a su cliente con status inicial del catalogo', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    tickets.seedAreas(areas); // JOIN-derived areaName — mismo patron que el resto del repo
    await areas.create({ name: 'Atención al cliente', color: '#111111' });
    const useCase = new CreatePortalTicket(tickets, areas, NO_CONTRACTS);

    const result = await useCase.execute('client-a', { subject: 'No anda internet', description: 'Desde ayer a la tarde' });

    expect(result.subject).toBe('No anda internet');
    expect(result.description).toBe('Desde ayer a la tarde');
    expect(result.status).toBe('open');
    expect(result.number).toEqual(expect.any(Number));

    const created = await tickets.getById((await tickets.list({ customerId: 'client-a' })).data[0]!.id);
    expect(created?.customerId).toBe('client-a');
    expect(created?.areaName).toBe('Atención al cliente');
  });

  it('área configurada resuelta por NOMBRE contra el catálogo', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    const supportArea = await areas.create({ name: 'Soporte Técnico', color: '#222222' });
    const useCase = new CreatePortalTicket(tickets, areas, NO_CONTRACTS, 'Soporte Técnico');

    await useCase.execute('client-a', { subject: 'Falla', description: 'detalle' });

    const listed = await tickets.list({ customerId: 'client-a' });
    expect(listed.data[0]!.areaId).toBe(supportArea.id);
  });

  it('área configurada NO existe en el catálogo -> fallback a la primera del catálogo, JAMÁS crea una nueva', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    const onlyArea = await areas.create({ name: 'NOC', color: '#333333' });
    const useCase = new CreatePortalTicket(tickets, areas, NO_CONTRACTS, 'Área que no existe');

    await useCase.execute('client-a', { subject: 'Falla', description: 'detalle' });

    const catalogAfter = await areas.list();
    expect(catalogAfter).toHaveLength(1); // ninguna área nueva creada
    const listed = await tickets.list({ customerId: 'client-a' });
    expect(listed.data[0]!.areaId).toBe(onlyArea.id);
  });

  it('scenario "Payload inválido": falta subject o description -> error de validación', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    const useCase = new CreatePortalTicket(tickets, areas, NO_CONTRACTS);

    await expect(useCase.execute('client-a', { subject: '', description: 'algo' })).rejects.toThrow(PortalTicketValidationError);
    await expect(useCase.execute('client-a', { subject: 'algo', description: '' })).rejects.toThrow(PortalTicketValidationError);
  });

  it('scenario "Payload inválido": largos maximos excedidos -> error de validación', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    const useCase = new CreatePortalTicket(tickets, areas, NO_CONTRACTS);

    const longSubject = 'x'.repeat(PORTAL_TICKET_SUBJECT_MAX_LEN + 1);
    const longDescription = 'y'.repeat(PORTAL_TICKET_DESCRIPTION_MAX_LEN + 1);

    await expect(useCase.execute('client-a', { subject: longSubject, description: 'ok' })).rejects.toThrow(PortalTicketValidationError);
    await expect(useCase.execute('client-a', { subject: 'ok', description: longDescription })).rejects.toThrow(PortalTicketValidationError);
  });

  it('anti-IDOR: el ticket queda asociado SOLO al clientId recibido, nunca a otro', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    const useCase = new CreatePortalTicket(tickets, areas, NO_CONTRACTS);

    await useCase.execute('client-a', { subject: 'De A', description: 'd' });
    await useCase.execute('client-b', { subject: 'De B', description: 'd' });

    const forA = await tickets.list({ customerId: 'client-a' });
    const forB = await tickets.list({ customerId: 'client-b' });
    expect(forA.data.map((t) => t.subject)).toEqual(['De A']);
    expect(forB.data.map((t) => t.subject)).toEqual(['De B']);
  });

  describe('v2.A (portal-ticket-contract) — "para abrir un reclamo debería seleccionar el contrato primero"', () => {
    it('cliente con contratos + contractId propio válido -> el ticket queda con ese contrato (id + label legible)', async () => {
      const tickets = new InMemoryTicketRepository();
      const areas = new InMemoryTicketAreaCatalogRepository();
      const customers = fakeCustomers({
        'client-a': [makeContract({ id: 'contract-a1', plan: '50 Mb Simetrico' })],
      });
      const useCase = new CreatePortalTicket(tickets, areas, customers);

      const result = await useCase.execute('client-a', { subject: 'No anda', description: 'desde ayer', contractId: 'contract-a1' });

      expect(result.contractId).toBe('contract-a1');
      expect(result.contractLabel).toBe('50 Mb Simetrico');
      const stored = await tickets.getBySequenceNumber(result.number);
      expect(stored?.contractId).toBe('contract-a1');
    });

    it('cliente con contratos y SIN contractId -> PortalContractRequiredError (400 CONTRACT_REQUIRED en la ruta)', async () => {
      const tickets = new InMemoryTicketRepository();
      const areas = new InMemoryTicketAreaCatalogRepository();
      const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'contract-a1' })] });
      const useCase = new CreatePortalTicket(tickets, areas, customers);

      await expect(useCase.execute('client-a', { subject: 'No anda', description: 'd' })).rejects.toThrow(PortalContractRequiredError);
      // string vacío se trata igual que ausente.
      await expect(useCase.execute('client-a', { subject: 'No anda', description: 'd', contractId: '' })).rejects.toThrow(PortalContractRequiredError);
    });

    it('contractId de OTRO cliente -> PortalContractNotFoundError (anti-IDOR — nunca revela si el id existe)', async () => {
      const tickets = new InMemoryTicketRepository();
      const areas = new InMemoryTicketAreaCatalogRepository();
      const customers = fakeCustomers({
        'client-a': [makeContract({ id: 'contract-a1' })],
        'client-b': [makeContract({ id: 'contract-b1' })],
      });
      const useCase = new CreatePortalTicket(tickets, areas, customers);

      // contractId real, pero de client-b -> para client-a debe fallar IGUAL
      // que uno inexistente (mismo error, ver test siguiente).
      await expect(
        useCase.execute('client-a', { subject: 'No anda', description: 'd', contractId: 'contract-b1' }),
      ).rejects.toThrow(PortalContractNotFoundError);
    });

    it('contractId inexistente -> el MISMO PortalContractNotFoundError que uno ajeno (no distingue)', async () => {
      const tickets = new InMemoryTicketRepository();
      const areas = new InMemoryTicketAreaCatalogRepository();
      const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'contract-a1' })] });
      const useCase = new CreatePortalTicket(tickets, areas, customers);

      await expect(
        useCase.execute('client-a', { subject: 'No anda', description: 'd', contractId: 'no-existe' }),
      ).rejects.toThrow(PortalContractNotFoundError);
    });

    it('cliente SIN contratos y sin contractId -> se crea igual, con contractId null (tiene derecho a pedir soporte)', async () => {
      const tickets = new InMemoryTicketRepository();
      const areas = new InMemoryTicketAreaCatalogRepository();
      const useCase = new CreatePortalTicket(tickets, areas, NO_CONTRACTS);

      const result = await useCase.execute('client-a', { subject: 'No anda', description: 'd' });

      expect(result.contractId).toBeNull();
      expect(result.contractLabel).toBeNull();
      const stored = await tickets.getBySequenceNumber(result.number);
      expect(stored?.contractId).toBeNull();
    });

    it('cliente SIN contratos pero manda un contractId igual -> PortalContractNotFoundError (nunca se ignora en silencio)', async () => {
      const tickets = new InMemoryTicketRepository();
      const areas = new InMemoryTicketAreaCatalogRepository();
      const useCase = new CreatePortalTicket(tickets, areas, NO_CONTRACTS);

      await expect(
        useCase.execute('client-a', { subject: 'No anda', description: 'd', contractId: 'contract-x' }),
      ).rejects.toThrow(PortalContractNotFoundError);
    });
  });
});
