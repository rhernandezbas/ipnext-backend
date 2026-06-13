/**
 * Recapture use-cases — strict TDD, all tested via InMemoryRecaptureRepository.
 * No Prisma mocking. Each describe block covers one use-case.
 */
import { InMemoryRecaptureRepository } from '../../../infrastructure/adapters/in-memory/InMemoryRecaptureRepository';
import { RecaptureLeadNotFoundError, RecaptureLeadAlreadyClaimedError } from '../../../domain/errors/recapture';
import { ListRecaptureLeads } from '../../../application/use-cases/recapture/ListRecaptureLeads';
import { GetRecaptureLead } from '../../../application/use-cases/recapture/GetRecaptureLead';
import { ClaimRecaptureLead } from '../../../application/use-cases/recapture/ClaimRecaptureLead';
import { ClaimNextRecaptureLead } from '../../../application/use-cases/recapture/ClaimNextRecaptureLead';
import { ReleaseRecaptureLead } from '../../../application/use-cases/recapture/ReleaseRecaptureLead';
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
    const uc = new ListRecaptureLeads(repo);
    const result = await uc.execute({});
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('returns all leads with DTO shape', async () => {
    const repo = makeRepo();
    await seedFreeLead(repo);
    const uc = new ListRecaptureLeads(repo);
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
    const uc = new ListRecaptureLeads(repo);
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
    const uc = new ListRecaptureLeads(repo);
    const result = await uc.execute({ unassigned: true });
    expect(result.total).toBe(1);
    expect(result.data[0]!.contactName).toBe('CSV Lead');
  });

  it('filters by assigneeId', async () => {
    const repo = makeRepo();
    await seedFreeLead(repo);
    await repo.create({ source: 'csv', contactName: 'Other' });
    await repo.claim('lead-001', 'user-99');
    const uc = new ListRecaptureLeads(repo);
    const result = await uc.execute({ assigneeId: 'user-99' });
    expect(result.total).toBe(1);
    expect(result.data[0]!.assigneeId).toBe('user-99');
  });

  it('paginates results', async () => {
    const repo = makeRepo();
    for (let i = 0; i < 5; i++) {
      await repo.create({ source: 'csv', contactName: `Lead ${i}` });
    }
    const uc = new ListRecaptureLeads(repo);
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

// ─── ClaimRecaptureLead ───────────────────────────────────────────────────────

describe('ClaimRecaptureLead', () => {
  it('claims a free lead and returns DTO with assigneeId', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const uc = new ClaimRecaptureLead(repo);
    const dto = await uc.execute(lead.id, 'user-A');
    expect(dto.assigneeId).toBe('user-A');
    expect(dto.status).toBe('en_gestion');
    expect(dto.claimedAt).not.toBeNull();
  });

  it('throws AlreadyClaimed when a second user tries to claim', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    const uc = new ClaimRecaptureLead(repo);
    await uc.execute(lead.id, 'user-A');
    await expect(uc.execute(lead.id, 'user-B')).rejects.toThrow(RecaptureLeadAlreadyClaimedError);
  });

  it('throws NotFound when lead id does not exist', async () => {
    const repo = makeRepo();
    const uc = new ClaimRecaptureLead(repo);
    await expect(uc.execute('ghost', 'user-A')).rejects.toThrow(RecaptureLeadNotFoundError);
  });
});

// ─── ClaimNextRecaptureLead ───────────────────────────────────────────────────

describe('ClaimNextRecaptureLead', () => {
  it('returns null when no free leads exist', async () => {
    const repo = makeRepo();
    const uc = new ClaimNextRecaptureLead(repo);
    const result = await uc.execute('user-A');
    expect(result).toBeNull();
  });

  it('claims the oldest free lead', async () => {
    const repo = makeRepo();
    // Seed two leads — first one should be claimed
    const first = await seedFreeLead(repo);
    await repo.create({ source: 'csv', contactName: 'Second Lead' });
    const uc = new ClaimNextRecaptureLead(repo);
    const dto = await uc.execute('user-A');
    expect(dto).not.toBeNull();
    expect(dto!.id).toBe(first.id);
    expect(dto!.assigneeId).toBe('user-A');
  });

  it('skips already-claimed leads', async () => {
    const repo = makeRepo();
    const first = await seedFreeLead(repo);
    await repo.create({ source: 'csv', contactName: 'Second Lead' });
    // Claim first
    await repo.claim(first.id, 'user-X');
    const uc = new ClaimNextRecaptureLead(repo);
    const dto = await uc.execute('user-A');
    expect(dto).not.toBeNull();
    expect(dto!.contactName).toBe('Second Lead');
  });
});

// ─── ReleaseRecaptureLead ─────────────────────────────────────────────────────

describe('ReleaseRecaptureLead', () => {
  it('releases a claimed lead back to nuevo/unassigned', async () => {
    const repo = makeRepo();
    const lead = await seedFreeLead(repo);
    await repo.claim(lead.id, 'user-A');
    const uc = new ReleaseRecaptureLead(repo);
    const dto = await uc.execute(lead.id);
    expect(dto.assigneeId).toBeNull();
    expect(dto.claimedAt).toBeNull();
    expect(dto.status).toBe('nuevo');
  });

  it('throws NotFound when id does not exist', async () => {
    const repo = makeRepo();
    const uc = new ReleaseRecaptureLead(repo);
    await expect(uc.execute('ghost')).rejects.toThrow(RecaptureLeadNotFoundError);
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
