/**
 * Recapture use-cases — strict TDD, all tested via InMemoryRecaptureRepository.
 * No Prisma mocking. Each describe block covers one use-case.
 */
import { InMemoryRecaptureRepository } from '../../../infrastructure/adapters/in-memory/InMemoryRecaptureRepository';
import { InMemoryContractRepository } from '../../../infrastructure/adapters/in-memory/InMemoryContractRepository';
import { RecaptureLeadNotFoundError } from '../../../domain/errors/recapture';
import { ListRecaptureLeads } from '../../../application/use-cases/recapture/ListRecaptureLeads';
import { GetRecaptureLead } from '../../../application/use-cases/recapture/GetRecaptureLead';

import { UpdateRecaptureLeadStatus } from '../../../application/use-cases/recapture/UpdateRecaptureLeadStatus';
import { AddRecaptureContact } from '../../../application/use-cases/recapture/AddRecaptureContact';
import { IngestChurnedClients } from '../../../application/use-cases/recapture/IngestChurnedClients';
import type { CustomerRepository } from '../../../domain/ports/CustomerRepository';
import type { RecaptureLead } from '../../../domain/entities/recaptureLead';

// ─── Shared setup ────────────────────────────────────────────────────────────

function makeRepo(): InMemoryRecaptureRepository {
  const repo = new InMemoryRecaptureRepository();
  repo.reset();
  return repo;
}

/** Empty contract repo — leads end up with technologies=[] (no contracts seeded). */
function makeEmptyContractRepo(): InMemoryContractRepository {
  return new InMemoryContractRepository();
}

/** Seed a contract (clientId + technology) into the InMemoryContractRepository. */
function seedTech(
  repo: InMemoryContractRepository,
  clientId: string,
  technology: string | null,
  status = 'active',
): void {
  repo.seed({ clientId, technology, status, clientName: `Client ${clientId}`, plan: 'plan' });
}

async function seedFreeLead(repo: InMemoryRecaptureRepository): Promise<RecaptureLead> {
  return repo.create({
    source: 'churned_client',
    clientId: 'client-1',
    contactName: 'Juan Pérez',
    phone: '1234567890',
    email: 'juan@example.com',
  });
}

// ─── ListRecaptureLeads ───────────────────────────────────────────────────────

describe('ListRecaptureLeads', () => {
  it('returns empty list when no leads exist', async () => {
    const repo = makeRepo();
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo());
    const result = await uc.execute({});
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('returns all leads with DTO shape', async () => {
    const repo = makeRepo();
    await seedFreeLead(repo);
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo());
    const result = await uc.execute({});
    expect(result.total).toBe(1);
    const dto = result.data[0]!;
    expect(dto).toMatchObject({
      source: 'churned_client',
      contactName: 'Juan Pérez',
      status: 'nuevo',
      assigneeId: null,
    });
  });

  it('filters by status', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    await repo.create({ source: 'csv', contactName: 'CSV Lead' });
    await repo.updateStatus(lead.id, 'contactado');
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo());
    const result = await uc.execute({ status: 'contactado' });
    expect(result.total).toBe(1);
    expect(result.data[0]!.status).toBe('contactado');
  });

  it('filters by unassigned=true', async () => {
    const repo = makeRepo();
    await seedFreeLead(repo);
    await repo.create({ source: 'csv', contactName: 'CSV Lead' });
    // Claim the first lead
    await repo.claim('lead-001', 'user-1');
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo());
    const result = await uc.execute({ unassigned: true });
    expect(result.total).toBe(1);
    expect(result.data[0]!.contactName).toBe('CSV Lead');
  });

  it('filters by assigneeId', async () => {
    const repo = makeRepo();
    await seedFreeLead(repo);
    await repo.create({ source: 'csv', contactName: 'Other' });
    await repo.claim('lead-001', 'user-99');
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo());
    const result = await uc.execute({ assigneeId: 'user-99' });
    expect(result.total).toBe(1);
    expect(result.data[0]!.assigneeId).toBe('user-99');
  });

  it('paginates results', async () => {
    const repo = makeRepo();
    for (let i = 0; i < 5; i++) {
      await repo.create({ source: 'csv', contactName: `Lead ${i}` });
    }
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo());
    const result = await uc.execute({ page: 2, limit: 2 });
    expect(result.data).toHaveLength(2);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(2);
    expect(result.total).toBe(5);
  });
});

// ─── GetRecaptureLead ─────────────────────────────────────────────────────────

describe('GetRecaptureLead', () => {
  it('returns lead with empty contacts when none appended', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const uc = new GetRecaptureLead(repo);
    const dto = await uc.execute(lead.id);
    expect(dto.id).toBe(lead.id);
    expect(dto.contacts).toHaveLength(0);
  });

  it('returns lead with contacts timeline', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    await repo.addContact({
      leadId: lead.id,
      actorId: 'user-1',
      channel: 'llamada',
      outcome: 'contactado',
    });
    const uc = new GetRecaptureLead(repo);
    const dto = await uc.execute(lead.id);
    expect(dto.contacts).toHaveLength(1);
    expect(dto.contacts[0]!.channel).toBe('llamada');
  });

  it('throws RecaptureLeadNotFoundError when id does not exist', async () => {
    const repo = makeRepo();
    const uc = new GetRecaptureLead(repo);
    await expect(uc.execute('nonexistent')).rejects.toThrow(RecaptureLeadNotFoundError);
  });
});

// ─── UpdateRecaptureLeadStatus ────────────────────────────────────────────────

describe('UpdateRecaptureLeadStatus', () => {
  it('updates the status of a lead', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const uc = new UpdateRecaptureLeadStatus(repo);
    const dto = await uc.execute(lead.id, 'interesado');
    expect(dto.status).toBe('interesado');
  });

  it('throws NotFound when id does not exist', async () => {
    const repo = makeRepo();
    const uc = new UpdateRecaptureLeadStatus(repo);
    await expect(uc.execute('ghost', 'interesado')).rejects.toThrow(RecaptureLeadNotFoundError);
  });
});

// ─── AddRecaptureContact ──────────────────────────────────────────────────────

describe('AddRecaptureContact', () => {
  it('appends a contact to an existing lead', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const uc = new AddRecaptureContact(repo);
    const dto = await uc.execute({
      leadId: lead.id,
      actorId: 'user-1',
      channel: 'whatsapp',
      outcome: 'interesado',
      note: 'Llamaron de nuevo',
    });
    expect(dto.leadId).toBe(lead.id);
    expect(dto.channel).toBe('whatsapp');
    expect(dto.outcome).toBe('interesado');
    expect(dto.note).toBe('Llamaron de nuevo');
  });

  it('optionally advances lead status', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const uc = new AddRecaptureContact(repo);
    await uc.execute({
      leadId: lead.id,
      actorId: 'user-1',
      channel: 'llamada',
      outcome: 'recuperado',
      advanceStatus: 'recuperado',
    });
    const detail = await repo.getById(lead.id);
    expect(detail!.status).toBe('recuperado');
  });

  it('throws NotFound when lead does not exist', async () => {
    const repo = makeRepo();
    const uc = new AddRecaptureContact(repo);
    await expect(
      uc.execute({ leadId: 'ghost', actorId: 'u1', channel: 'email', outcome: 'contactado' }),
    ).rejects.toThrow(RecaptureLeadNotFoundError);
  });
});

// ─── IngestChurnedClients ─────────────────────────────────────────────────────

describe('IngestChurnedClients', () => {
  function makeCustomerRepo(clients: Array<{ id: string; name: string; phone: string; email: string }>): CustomerRepository {
    return {
      list: jest.fn().mockResolvedValue({ data: clients, total: clients.length, page: 1, limit: 10000 }),
      findById: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      stats: jest.fn(),
      listContracts: jest.fn(),
      listInvoices: jest.fn(),
      listLogs: jest.fn(),
    } as unknown as CustomerRepository;
  }

  it('creates leads for baja clients', async () => {
    const repo = makeRepo();
    const customerRepo = makeCustomerRepo([
      { id: 'c-1', name: 'Alice', phone: '111', email: 'alice@test.com' },
      { id: 'c-2', name: 'Bob', phone: '222', email: 'bob@test.com' },
    ]);
    const uc = new IngestChurnedClients(repo, customerRepo);
    const result = await uc.execute();
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);

    const list = await repo.list({});
    expect(list.total).toBe(2);
    expect(list.data[0]!.source).toBe('churned_client');
  });

  it('is idempotent — skips existing leads', async () => {
    const repo = makeRepo();
    const customerRepo = makeCustomerRepo([
      { id: 'c-1', name: 'Alice', phone: '111', email: 'alice@test.com' },
    ]);
    const uc = new IngestChurnedClients(repo, customerRepo);
    await uc.execute();
    const second = await uc.execute();
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);

    const list = await repo.list({});
    expect(list.total).toBe(1);
  });

  it('returns created=0 when no baja clients', async () => {
    const repo = makeRepo();
    const customerRepo = makeCustomerRepo([]);
    const uc = new IngestChurnedClients(repo, customerRepo);
    const result = await uc.execute();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

// ─── ListRecaptureLeads — technologies enrichment ─────────────────────────────

describe('ListRecaptureLeads — technologies enrichment', () => {
  it('enriches each lead with the DISTINCT technologies of its client contracts', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    const lead = await repo.create({ source: 'churned_client', clientId: 'client-1', contactName: 'Multi' });
    seedTech(contractRepo, 'client-1', 'Fiber');
    seedTech(contractRepo, 'client-1', 'Wireless');

    const uc = new ListRecaptureLeads(repo, contractRepo);
    const result = await uc.execute({});

    const dto = result.data.find((d) => d.id === lead.id)!;
    expect([...dto.technologies].sort()).toEqual(['Fiber', 'Wireless']);
  });

  it('returns [] technologies for a lead without clientId', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    await repo.create({ source: 'csv', contactName: 'No client' }); // clientId is null
    // Even if some other client has contracts, a lead with no clientId stays empty.
    seedTech(contractRepo, 'client-99', 'Fiber');

    const uc = new ListRecaptureLeads(repo, contractRepo);
    const result = await uc.execute({});

    expect(result.data[0]!.technologies).toEqual([]);
  });

  it('counts contracts of ALL statuses, including baja (no status filter)', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    await repo.create({ source: 'churned_client', clientId: 'client-1', contactName: 'Baja contracts' });
    seedTech(contractRepo, 'client-1', 'Fiber', 'active');
    seedTech(contractRepo, 'client-1', 'DOCSIS', 'baja'); // a churned contract still contributes

    const uc = new ListRecaptureLeads(repo, contractRepo);
    const result = await uc.execute({});

    expect([...result.data[0]!.technologies].sort()).toEqual(['DOCSIS', 'Fiber']);
  });

  it('dedupes repeated technologies and drops null/empty values', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    await repo.create({ source: 'churned_client', clientId: 'client-1', contactName: 'Dupes' });
    seedTech(contractRepo, 'client-1', 'Fiber');
    seedTech(contractRepo, 'client-1', 'Fiber');
    seedTech(contractRepo, 'client-1', null);
    seedTech(contractRepo, 'client-1', '  '); // whitespace-only → dropped

    const uc = new ListRecaptureLeads(repo, contractRepo);
    const result = await uc.execute({});

    expect(result.data[0]!.technologies).toEqual(['Fiber']);
  });

  it('batch-fetches technologies ONCE for the whole page (anti-N+1)', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    for (let i = 1; i <= 5; i++) {
      await repo.create({ source: 'churned_client', clientId: `client-${i}`, contactName: `Lead ${i}` });
      seedTech(contractRepo, `client-${i}`, 'Fiber');
    }
    const spy = jest.spyOn(contractRepo, 'findContractTechnologiesByClientIds');

    const uc = new ListRecaptureLeads(repo, contractRepo);
    await uc.execute({});

    expect(spy).toHaveBeenCalledTimes(1);
    expect([...spy.mock.calls[0]![0]].sort()).toEqual([
      'client-1', 'client-2', 'client-3', 'client-4', 'client-5',
    ]);
  });
});

// ─── ListRecaptureLeads — technology filter (server-side) ─────────────────────

describe('ListRecaptureLeads — technology filter', () => {
  async function seedClientLeads(
    repo: InMemoryRecaptureRepository,
    contractRepo: InMemoryContractRepository,
  ): Promise<void> {
    await repo.create({ source: 'churned_client', clientId: 'wireless-1', contactName: 'W1' });
    await repo.create({ source: 'churned_client', clientId: 'fiber-1', contactName: 'F1' });
    await repo.create({ source: 'csv', contactName: 'No client' }); // clientId null → never matches
    seedTech(contractRepo, 'wireless-1', 'Wireless');
    seedTech(contractRepo, 'fiber-1', 'Fiber');
  }

  it('returns only leads whose client has a contract of the given technology', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    await seedClientLeads(repo, contractRepo);

    const uc = new ListRecaptureLeads(repo, contractRepo);
    const result = await uc.execute({ technology: 'Wireless' });

    expect(result.total).toBe(1);
    expect(result.data[0]!.clientId).toBe('wireless-1');
    expect(result.data[0]!.technologies).toEqual(['Wireless']);
  });

  it('returns an empty page when no client matches the technology', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    await seedClientLeads(repo, contractRepo);

    const uc = new ListRecaptureLeads(repo, contractRepo);
    const result = await uc.execute({ technology: 'HFC' });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('paginates OVER the filtered set (filter runs before pagination)', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    for (let i = 1; i <= 3; i++) {
      await repo.create({ source: 'churned_client', clientId: `w-${i}`, contactName: `W${i}` });
      seedTech(contractRepo, `w-${i}`, 'Wireless');
    }
    for (let i = 1; i <= 2; i++) {
      await repo.create({ source: 'churned_client', clientId: `f-${i}`, contactName: `F${i}` });
      seedTech(contractRepo, `f-${i}`, 'Fiber');
    }

    const uc = new ListRecaptureLeads(repo, contractRepo);
    const result = await uc.execute({ technology: 'Wireless', page: 1, limit: 2 });

    expect(result.total).toBe(3);        // total reflects the filtered set, not all 5 leads
    expect(result.data).toHaveLength(2); // page 1 of 2
    result.data.forEach((d) => expect(d.technologies).toEqual(['Wireless']));
  });
});
