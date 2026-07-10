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
import type { CustomerRepository, ActiveClientContact } from '../../../domain/ports/CustomerRepository';
import type { ContractRepository } from '../../../domain/ports/ContractRepository';
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

/**
 * Seed a contract into the InMemoryContractRepository.
 * The technology shown in Recaptación is DERIVED (deriveTechnology): the manual
 * `technology` wins when set; otherwise it is classified from the `plan` speed.
 * In prod `Contract.technology` is NULL for all rows, so tests seed a real `plan`
 * and (optionally) a manual technology that should override the derivation.
 */
function seedTech(
  repo: InMemoryContractRepository,
  clientId: string,
  opts: { plan: string; technology?: string | null; status?: string },
): void {
  repo.seed({
    clientId,
    technology: opts.technology ?? null,
    plan: opts.plan,
    status: opts.status ?? 'active',
    clientName: `Client ${clientId}`,
  });
}

/**
 * recapture-active-client-match — jest-stub `CustomerRepository` for the
 * `listActiveContacts()` dependency of `ListRecaptureLeads`/`GetRecaptureLead`.
 * Established convention (Batch 1 / IngestChurnedClients precedent): no new
 * InMemory adapter class, just a narrow `jest.fn()` cast through the port.
 */
function makeActiveContactsRepo(contacts: ActiveClientContact[] = []): CustomerRepository {
  return {
    listActiveContacts: jest.fn().mockResolvedValue(contacts),
  } as unknown as CustomerRepository;
}

/** Simulates `listActiveContacts()` failing — exercises the fail-open path (design.md Decisión 3). */
function makeThrowingCustomerRepo(): CustomerRepository {
  return {
    listActiveContacts: jest.fn().mockRejectedValue(new Error('listActiveContacts boom')),
  } as unknown as CustomerRepository;
}

/**
 * Fix-wave Finding 1/3b — simulates `findContractTechnologiesByClientIds()` failing.
 * Same narrow jest.fn()-through-the-port convention as `makeThrowingCustomerRepo`.
 */
function makeThrowingContractRepo(): ContractRepository {
  return {
    findContractTechnologiesByClientIds: jest.fn().mockRejectedValue(new Error('findContractTechnologiesByClientIds boom')),
  } as unknown as ContractRepository;
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
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), makeActiveContactsRepo());
    const result = await uc.execute({});
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('returns all leads with DTO shape', async () => {
    const repo = makeRepo();
    await seedFreeLead(repo);
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), makeActiveContactsRepo());
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
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), makeActiveContactsRepo());
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
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), makeActiveContactsRepo());
    const result = await uc.execute({ unassigned: true });
    expect(result.total).toBe(1);
    expect(result.data[0]!.contactName).toBe('CSV Lead');
  });

  it('filters by assigneeId', async () => {
    const repo = makeRepo();
    await seedFreeLead(repo);
    await repo.create({ source: 'csv', contactName: 'Other' });
    await repo.claim('lead-001', 'user-99');
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), makeActiveContactsRepo());
    const result = await uc.execute({ assigneeId: 'user-99' });
    expect(result.total).toBe(1);
    expect(result.data[0]!.assigneeId).toBe('user-99');
  });

  it('paginates results', async () => {
    const repo = makeRepo();
    for (let i = 0; i < 5; i++) {
      await repo.create({ source: 'csv', contactName: `Lead ${i}` });
    }
    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), makeActiveContactsRepo());
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
    const uc = new GetRecaptureLead(repo, makeActiveContactsRepo(), makeEmptyContractRepo());
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
    const uc = new GetRecaptureLead(repo, makeActiveContactsRepo(), makeEmptyContractRepo());
    const dto = await uc.execute(lead.id);
    expect(dto.contacts).toHaveLength(1);
    expect(dto.contacts[0]!.channel).toBe('llamada');
  });

  it('throws RecaptureLeadNotFoundError when id does not exist', async () => {
    const repo = makeRepo();
    const uc = new GetRecaptureLead(repo, makeActiveContactsRepo(), makeEmptyContractRepo());
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
    const uc = new IngestChurnedClients(repo, customerRepo, makeEmptyContractRepo());
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
    const uc = new IngestChurnedClients(repo, customerRepo, makeEmptyContractRepo());
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
    const uc = new IngestChurnedClients(repo, customerRepo, makeEmptyContractRepo());
    const result = await uc.execute();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(0);
  });

  // recapture-active-client-match — Decisión 5b: populate churnReason from the
  // baja client's persisted Contract.motivoBaja, create-only/idempotent.
  it('a new lead inherits churnReason from the baja contract\'s motivoBaja (S15a)', async () => {
    const repo = makeRepo();
    const customerRepo = makeCustomerRepo([
      { id: 'c-1', name: 'Alice', phone: '111', email: 'alice@test.com' },
    ]);
    const contractRepo = new InMemoryContractRepository();
    contractRepo.seed({
      clientId: 'c-1',
      clientName: 'Alice',
      plan: 'IP-Air-30',
      status: 'baja',
      motivoBaja: 'CAMBIO DE TITULARIDAD',
    });

    const uc = new IngestChurnedClients(repo, customerRepo, contractRepo);
    await uc.execute();

    const list = await repo.list({});
    expect(list.data[0]!.churnReason).toBe('CAMBIO DE TITULARIDAD');
  });

  it('idempotent ingest does NOT re-stamp churnReason on an existing lead (S15b)', async () => {
    const repo = makeRepo();
    const customerRepo = makeCustomerRepo([
      { id: 'c-1', name: 'Alice', phone: '111', email: 'alice@test.com' },
    ]);
    // First run: contract has NO motivoBaja yet → lead is created with churnReason=null.
    const contractRepo = new InMemoryContractRepository();
    contractRepo.seed({ clientId: 'c-1', clientName: 'Alice', plan: 'IP-Air-30', status: 'baja' });
    const uc = new IngestChurnedClients(repo, customerRepo, contractRepo);
    await uc.execute();

    let list = await repo.list({});
    expect(list.data[0]!.churnReason).toBeNull();

    // Contract is re-synced later and NOW carries a motivoBaja — but the lead
    // already exists, so the SECOND ingest run must NOT re-stamp it (forward-only;
    // this lead's churn_reason coverage comes from the match-time contract read, not a backfill).
    contractRepo.seed({ clientId: 'c-1', clientName: 'Alice', plan: 'IP-Air-30', status: 'baja', motivoBaja: 'CAMBIO DE TITULARIDAD' });
    const second = await uc.execute();
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);

    list = await repo.list({});
    expect(list.total).toBe(1);
    expect(list.data[0]!.churnReason).toBeNull();
  });
});

// ─── ListRecaptureLeads — technologies enrichment ─────────────────────────────

describe('ListRecaptureLeads — technologies enrichment', () => {
  it('enriches each lead with the DISTINCT technologies DERIVED from its contract plans', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    const lead = await repo.create({ source: 'churned_client', clientId: 'client-1', contactName: 'Multi' });
    // technology column is NULL (as in prod) → derive from the plan speed.
    seedTech(contractRepo, 'client-1', { plan: '300MB' });   // ≥100 → Fiber
    seedTech(contractRepo, 'client-1', { plan: '10/5MB' });  // <100 → Wireless

    const uc = new ListRecaptureLeads(repo, contractRepo, makeActiveContactsRepo());
    const result = await uc.execute({});

    const dto = result.data.find((d) => d.id === lead.id)!;
    expect([...dto.technologies].sort()).toEqual(['Fiber', 'Wireless']);
  });

  it('returns [] technologies for a lead without clientId', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    await repo.create({ source: 'csv', contactName: 'No client' }); // clientId is null
    // Even if some other client has contracts, a lead with no clientId stays empty.
    seedTech(contractRepo, 'client-99', { plan: '300MB' });

    const uc = new ListRecaptureLeads(repo, contractRepo, makeActiveContactsRepo());
    const result = await uc.execute({});

    expect(result.data[0]!.technologies).toEqual([]);
  });

  it('counts contracts of ALL statuses (baja included) and lets a MANUAL technology win over derivation', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    await repo.create({ source: 'churned_client', clientId: 'client-1', contactName: 'Baja contracts' });
    seedTech(contractRepo, 'client-1', { plan: '300MB', status: 'active' });               // derived → Fiber
    seedTech(contractRepo, 'client-1', { technology: 'DOCSIS', plan: 'TV', status: 'baja' }); // manual wins; baja still contributes

    const uc = new ListRecaptureLeads(repo, contractRepo, makeActiveContactsRepo());
    const result = await uc.execute({});

    expect([...result.data[0]!.technologies].sort()).toEqual(['DOCSIS', 'Fiber']);
  });

  it('dedupes DERIVED technologies and drops unclassified / null / whitespace values', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    await repo.create({ source: 'churned_client', clientId: 'client-1', contactName: 'Dupes' });
    seedTech(contractRepo, 'client-1', { plan: '300MB' });                  // → Fiber
    seedTech(contractRepo, 'client-1', { plan: '500MB' });                  // → Fiber (dup after derive)
    seedTech(contractRepo, 'client-1', { plan: 'Instalacion Wireless H' }); // no integer → unclassified → dropped
    seedTech(contractRepo, 'client-1', { technology: '  ', plan: '300MB' }); // whitespace manual → trimmed → dropped

    const uc = new ListRecaptureLeads(repo, contractRepo, makeActiveContactsRepo());
    const result = await uc.execute({});

    expect(result.data[0]!.technologies).toEqual(['Fiber']);
  });

  it('batch-fetches technologies ONCE for the whole page (anti-N+1)', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    for (let i = 1; i <= 5; i++) {
      await repo.create({ source: 'churned_client', clientId: `client-${i}`, contactName: `Lead ${i}` });
      seedTech(contractRepo, `client-${i}`, { plan: '300MB' });
    }
    const spy = jest.spyOn(contractRepo, 'findContractTechnologiesByClientIds');

    const uc = new ListRecaptureLeads(repo, contractRepo, makeActiveContactsRepo());
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
    // technology NULL (as in prod) → the filter must DERIVE from the plan speed.
    seedTech(contractRepo, 'wireless-1', { plan: '10/5MB' }); // <100 → Wireless
    seedTech(contractRepo, 'fiber-1', { plan: '300MB' });     // ≥100 → Fiber
  }

  it('returns only leads whose client has a contract of the given technology', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    await seedClientLeads(repo, contractRepo);

    const uc = new ListRecaptureLeads(repo, contractRepo, makeActiveContactsRepo());
    const result = await uc.execute({ technology: 'Wireless' });

    expect(result.total).toBe(1);
    expect(result.data[0]!.clientId).toBe('wireless-1');
    expect(result.data[0]!.technologies).toEqual(['Wireless']);
  });

  it('returns an empty page when no client matches the technology', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    await seedClientLeads(repo, contractRepo);

    const uc = new ListRecaptureLeads(repo, contractRepo, makeActiveContactsRepo());
    const result = await uc.execute({ technology: 'HFC' });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('paginates OVER the filtered set (filter runs before pagination)', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    for (let i = 1; i <= 3; i++) {
      await repo.create({ source: 'churned_client', clientId: `w-${i}`, contactName: `W${i}` });
      seedTech(contractRepo, `w-${i}`, { plan: '30/10MB' }); // → Wireless
    }
    for (let i = 1; i <= 2; i++) {
      await repo.create({ source: 'churned_client', clientId: `f-${i}`, contactName: `F${i}` });
      seedTech(contractRepo, `f-${i}`, { plan: '100 MB' }); // → Fiber
    }

    const uc = new ListRecaptureLeads(repo, contractRepo, makeActiveContactsRepo());
    const result = await uc.execute({ technology: 'Wireless', page: 1, limit: 2 });

    expect(result.total).toBe(3);        // total reflects the filtered set, not all 5 leads
    expect(result.data).toHaveLength(2); // page 1 of 2
    result.data.forEach((d) => expect(d.technologies).toEqual(['Wireless']));
  });

  it('a MANUAL technology wins over plan derivation in the filter', async () => {
    const repo = makeRepo();
    const contractRepo = new InMemoryContractRepository();
    // plan '20/5MB' derives to Wireless, but the manual 'Fiber' overrides it.
    await repo.create({ source: 'churned_client', clientId: 'override-1', contactName: 'Override' });
    seedTech(contractRepo, 'override-1', { technology: 'Fiber', plan: '20/5MB' });

    const uc = new ListRecaptureLeads(repo, contractRepo, makeActiveContactsRepo());
    const result = await uc.execute({ technology: 'Fiber' });

    expect(result.total).toBe(1);
    expect(result.data[0]!.clientId).toBe('override-1');
    expect(result.data[0]!.technologies).toEqual(['Fiber']);
  });
});

// ─── ListRecaptureLeads — active-client match enrichment (recapture-active-client-match) ──

describe('ListRecaptureLeads — active-client match enrichment', () => {
  it('returns [] possibleActiveMatchSignals when nothing matches', async () => {
    const repo = makeRepo();
    await repo.create({ source: 'csv', contactName: 'No match', phone: '1112223333', email: 'nomatch@test.com' });
    const customerRepo = makeActiveContactsRepo([
      { id: 'c-unrelated', name: 'Unrelated', phone: '9998887777', email: 'unrelated@test.com' },
    ]);

    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), customerRepo);
    const result = await uc.execute({});

    expect(result.data[0]!.possibleActiveMatchSignals).toEqual([]);
  });

  it('computes the phone signal against the active-contact candidate set', async () => {
    const repo = makeRepo();
    await repo.create({ source: 'csv', contactName: 'Phone match', phone: '+54 9 11 1234-5678' });
    const customerRepo = makeActiveContactsRepo([
      { id: 'c-active-1', name: 'Active One', phone: '011 15-1234-5678', email: null },
    ]);

    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), customerRepo);
    const result = await uc.execute({});

    expect(result.data[0]!.possibleActiveMatchSignals).toEqual(['phone']);
  });

  it('computes the reactivated signal when the lead\'s own clientId is active', async () => {
    const repo = makeRepo();
    await repo.create({ source: 'churned_client', clientId: 'client-9', contactName: 'Reactivated' });
    const customerRepo = makeActiveContactsRepo([
      { id: 'client-9', name: 'Client Nine', phone: null, email: null },
    ]);

    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), customerRepo);
    const result = await uc.execute({});

    expect(result.data[0]!.possibleActiveMatchSignals).toEqual(['reactivated']);
  });

  it('computes the churn_reason signal from lead.churnReason (source-agnostic seam — Batch 3B adds Contract.motivoBaja)', async () => {
    const repo = makeRepo();
    await repo.create({ source: 'csv', contactName: 'Titularidad', churnReason: 'CAMBIO DE TITULARIDAD' });

    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), makeActiveContactsRepo());
    const result = await uc.execute({});

    expect(result.data[0]!.possibleActiveMatchSignals).toEqual(['churn_reason']);
  });

  // recapture-active-client-match — Decisión 6: churn_reason from the OTHER source
  // (the lead's own client's persisted Contract.motivoBaja), no lead.churnReason at all.
  it('computes the churn_reason signal from the lead\'s client Contract.motivoBaja (S16a — no lead.churnReason)', async () => {
    const repo = makeRepo();
    await repo.create({ source: 'churned_client', clientId: 'client-1', contactName: 'Baja sin motivo propio' });
    const contractRepo = new InMemoryContractRepository();
    contractRepo.seed({
      clientId: 'client-1',
      clientName: 'Baja sin motivo propio',
      plan: 'IP-Air-30',
      status: 'baja',
      motivoBaja: 'CAMBIO DE TITULARIDAD',
    });

    const uc = new ListRecaptureLeads(repo, contractRepo, makeActiveContactsRepo());
    const result = await uc.execute({});

    expect(result.data[0]!.possibleActiveMatchSignals).toEqual(['churn_reason']);
  });

  it('calls listActiveContacts() exactly ONCE per page regardless of lead count (anti-N+1)', async () => {
    const repo = makeRepo();
    for (let i = 0; i < 5; i++) {
      await repo.create({ source: 'csv', contactName: `Lead ${i}` });
    }
    const customerRepo = makeActiveContactsRepo([]);

    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), customerRepo);
    await uc.execute({});

    expect(customerRepo.listActiveContacts).toHaveBeenCalledTimes(1);
  });

  it('does NOT call listActiveContacts() when the page is empty (S1b)', async () => {
    const repo = makeRepo();
    const customerRepo = makeActiveContactsRepo([]);

    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), customerRepo);
    const result = await uc.execute({});

    expect(result.data).toHaveLength(0);
    expect(customerRepo.listActiveContacts).not.toHaveBeenCalled();
  });

  it('fails OPEN with [] signals for every lead when listActiveContacts() rejects (design.md Decisión 3)', async () => {
    const repo = makeRepo();
    await repo.create({ source: 'csv', contactName: 'A' });
    await repo.create({ source: 'csv', contactName: 'B' });
    const customerRepo = makeThrowingCustomerRepo();

    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), customerRepo);
    const result = await uc.execute({});

    expect(result.data).toHaveLength(2);
    result.data.forEach((d) => expect(d.possibleActiveMatchSignals).toEqual([]));
  });

  // Fix-wave Finding 1 — the contract batch used to run OUTSIDE the fail-open
  // guard: a throwing findContractTechnologiesByClientIds() 500'd the whole list.
  // design.md Decisión 3: "un contrato corrupto JAMÁS debe voltear la tabla".
  it('Finding 1: findContractTechnologiesByClientIds() rejecting must NOT break the list — degrades technologies to [], drops the contract-sourced churn text, but phone + lead.churnReason signals still fire', async () => {
    const repo = makeRepo();
    await repo.create({
      source: 'churned_client',
      clientId: 'client-1',
      contactName: 'Still matches',
      phone: '2324421234',
      churnReason: 'CAMBIO DE TITULARIDAD',
    });
    const contractRepo = makeThrowingContractRepo();
    const customerRepo = makeActiveContactsRepo([
      { id: 'c-2', name: 'Client Two', phone: '2324421234', email: null },
    ]);

    const uc = new ListRecaptureLeads(repo, contractRepo, customerRepo);
    const result = await uc.execute({});

    expect(result.data).toHaveLength(1);
    const dto = result.data[0]!;
    expect(dto.technologies).toEqual([]); // contract batch degraded to []
    // phone (from listActiveContacts, unaffected) + churn_reason (from lead.churnReason,
    // NOT the contract) both still compute — only the contract-sourced motivoBaja text is lost.
    expect([...dto.possibleActiveMatchSignals].sort()).toEqual(['churn_reason', 'phone']);
  });
});

// ─── ListRecaptureLeads — fail-open logging (Fix-wave Finding 2) ──────────────

describe('ListRecaptureLeads — fail-open logging (Finding 2)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs once when findContractTechnologiesByClientIds() rejects', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = makeRepo();
    await repo.create({ source: 'churned_client', clientId: 'client-1', contactName: 'A' });

    const uc = new ListRecaptureLeads(repo, makeThrowingContractRepo(), makeActiveContactsRepo());
    await uc.execute({});

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('logs once when listActiveContacts() rejects', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = makeRepo();
    await repo.create({ source: 'csv', contactName: 'A' });

    const uc = new ListRecaptureLeads(repo, makeEmptyContractRepo(), makeThrowingCustomerRepo());
    await uc.execute({});

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── GetRecaptureLead — active-client match enrichment (recapture-active-client-match) ────

describe('GetRecaptureLead — active-client match enrichment', () => {
  it('returns possibleActiveMatch = {signals: [], matchedClients: []} when nothing matches (S9a — never undefined)', async () => {
    const repo = makeRepo();
    const lead = await repo.create({ source: 'csv', contactName: 'No match' });
    const uc = new GetRecaptureLead(repo, makeActiveContactsRepo([]), makeEmptyContractRepo());

    const dto = await uc.execute(lead.id);

    expect(dto.possibleActiveMatch).toEqual({ signals: [], matchedClients: [] });
  });

  it('reports every matched active client, deduplicated by clientId (S8 detail — cardinality)', async () => {
    const repo = makeRepo();
    const lead = await repo.create({
      source: 'csv',
      contactName: 'Multi match',
      clientId: 'lead-owner', // not active itself → no 'reactivated'
      phone: '2324421234',
    });
    const customerRepo = makeActiveContactsRepo([
      { id: 'c-2', name: 'Client Two', phone: '02324 421234', email: null }, // phone match
      { id: 'c-3', name: 'Client Three', phone: null, email: null },        // no match, present in candidate set
    ]);

    const uc = new GetRecaptureLead(repo, customerRepo, makeEmptyContractRepo());
    const dto = await uc.execute(lead.id);

    expect(dto.possibleActiveMatch.signals).toEqual(['phone']);
    expect(dto.possibleActiveMatch.matchedClients).toHaveLength(1);
    expect(dto.possibleActiveMatch.matchedClients[0]).toMatchObject({
      clientId: 'c-2',
      name: 'Client Two',
      status: 'active',
      matchedBy: ['phone'],
    });
  });

  it('reports churn_reason with matchedClients: [] when there is no client match (S9b)', async () => {
    const repo = makeRepo();
    const lead = await repo.create({
      source: 'csv',
      contactName: 'Churn only',
      churnReason: 'Solicitó baja por CAMBIO DE TITULARIDAD',
    });
    const uc = new GetRecaptureLead(repo, makeActiveContactsRepo([]), makeEmptyContractRepo());

    const dto = await uc.execute(lead.id);

    expect(dto.possibleActiveMatch.signals).toEqual(['churn_reason']);
    expect(dto.possibleActiveMatch.matchedClients).toEqual([]);
  });

  // recapture-active-client-match — Decisión 6: same source-agnostic seam on the detail side.
  it('computes churn_reason from the lead\'s client Contract.motivoBaja (S16a detail — no lead.churnReason)', async () => {
    const repo = makeRepo();
    const lead = await repo.create({ source: 'churned_client', clientId: 'client-1', contactName: 'Baja sin motivo propio' });
    const contractRepo = new InMemoryContractRepository();
    contractRepo.seed({
      clientId: 'client-1',
      clientName: 'Baja sin motivo propio',
      plan: 'IP-Air-30',
      status: 'baja',
      motivoBaja: 'CAMBIO DE TITULARIDAD',
    });

    const uc = new GetRecaptureLead(repo, makeActiveContactsRepo([]), contractRepo);
    const dto = await uc.execute(lead.id);

    expect(dto.possibleActiveMatch.signals).toEqual(['churn_reason']);
    expect(dto.possibleActiveMatch.matchedClients).toEqual([]);
  });

  it('fails OPEN to the empty shape when listActiveContacts() rejects', async () => {
    const repo = makeRepo();
    const lead = await repo.create({ source: 'csv', contactName: 'Boom' });
    const uc = new GetRecaptureLead(repo, makeThrowingCustomerRepo(), makeEmptyContractRepo());

    const dto = await uc.execute(lead.id);

    expect(dto.possibleActiveMatch).toEqual({ signals: [], matchedClients: [] });
  });

  it('calling execute() repeatedly is read-only — no mutation of the lead or the matched client (S10)', async () => {
    const repo = makeRepo();
    const lead = await repo.create({ source: 'csv', contactName: 'Idempotent', phone: '2324421234' });
    const customerRepo = makeActiveContactsRepo([
      { id: 'c-2', name: 'Client Two', phone: '2324421234', email: null },
    ]);
    const uc = new GetRecaptureLead(repo, customerRepo, makeEmptyContractRepo());

    const first = await uc.execute(lead.id);
    const second = await uc.execute(lead.id);

    expect(second).toEqual(first);
    expect(customerRepo.listActiveContacts).toHaveBeenCalledTimes(2);
    const stored = await repo.getById(lead.id);
    expect(stored!.updatedAt).toBe(lead.updatedAt);
  });

  // Fix-wave Finding 3b — pins that a contract-read failure degrades ONLY the
  // contract-sourced churn text; signals computed from the (successful) active-contact
  // read must still fire. Requires the same granular fail-open split as Finding 1's fix.
  it('Finding 3b: findContractTechnologiesByClientIds() rejects — detail resolves with signals still computed from remaining sources (no throw)', async () => {
    const repo = makeRepo();
    const lead = await repo.create({
      source: 'churned_client',
      clientId: 'client-1',
      contactName: 'Partial degrade',
      phone: '2324421234',
    });
    const customerRepo = makeActiveContactsRepo([
      { id: 'c-2', name: 'Client Two', phone: '2324421234', email: null },
    ]);

    const uc = new GetRecaptureLead(repo, customerRepo, makeThrowingContractRepo());
    const dto = await uc.execute(lead.id);

    expect(dto.possibleActiveMatch.signals).toEqual(['phone']);
    expect(dto.possibleActiveMatch.matchedClients).toHaveLength(1);
    expect(dto.possibleActiveMatch.matchedClients[0]).toMatchObject({ clientId: 'c-2', matchedBy: ['phone'] });
  });
});

// ─── GetRecaptureLead — fail-open logging (Fix-wave Finding 2) ────────────────

describe('GetRecaptureLead — fail-open logging (Finding 2)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs once when listActiveContacts() rejects', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = makeRepo();
    const lead = await repo.create({ source: 'csv', contactName: 'Boom' });

    const uc = new GetRecaptureLead(repo, makeThrowingCustomerRepo(), makeEmptyContractRepo());
    await uc.execute(lead.id);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('logs once when findContractTechnologiesByClientIds() rejects', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = makeRepo();
    const lead = await repo.create({ source: 'churned_client', clientId: 'client-1', contactName: 'Boom' });

    const uc = new GetRecaptureLead(repo, makeActiveContactsRepo(), makeThrowingContractRepo());
    await uc.execute(lead.id);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
