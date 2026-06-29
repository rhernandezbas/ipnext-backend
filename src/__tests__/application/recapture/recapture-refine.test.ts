/**
 * Recapture-refine — strict TDD.
 * Covers: #3b assigneeName, #4 source filter, advanceStatus contract.
 * All tests via InMemoryRecaptureRepository. No Prisma mocking.
 */
import { InMemoryRecaptureRepository } from '../../../infrastructure/adapters/in-memory/InMemoryRecaptureRepository';
import { InMemoryContractRepository } from '../../../infrastructure/adapters/in-memory/InMemoryContractRepository';
import { ListRecaptureLeads } from '../../../application/use-cases/recapture/ListRecaptureLeads';
import { GetRecaptureLead } from '../../../application/use-cases/recapture/GetRecaptureLead';
import { AddRecaptureContact } from '../../../application/use-cases/recapture/AddRecaptureContact';
import type { RecaptureLead } from '../../../domain/entities/recaptureLead';

function makeRepo(): InMemoryRecaptureRepository {
  const repo = new InMemoryRecaptureRepository();
  repo.reset();
  return repo;
}

// ─── #3b — assigneeName ───────────────────────────────────────────────────────

describe('#3b — assigneeName in RecaptureLeadDto', () => {
  it('list() returns assigneeName=null when lead is unassigned', async () => {
    const repo = makeRepo();
    await repo.create({ source: 'csv', contactName: 'Sin asignar' });
    const uc = new ListRecaptureLeads(repo, new InMemoryContractRepository());
    const result = await uc.execute({});
    const dto = result.data[0]!;
    expect(dto).toHaveProperty('assigneeName', null);
  });

  it('list() passes assigneeName through when lead has an assignee', async () => {
    const repo = makeRepo();
    // Seed a lead that already carries assigneeName (simulates a claimed lead
    // where the Prisma adapter resolves the name). InMemory stores the domain
    // entity as-is, so we seed with assigneeName pre-resolved.
    const lead: RecaptureLead = {
      id: 'lead-with-assignee',
      source: 'churned_client',
      clientId: null,
      contactName: 'Con asignado',
      phone: null,
      email: null,
      status: 'en_gestion',
      assigneeId: 'user-42',
      assigneeName: 'María López',
      claimedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      address: null,
      churnReason: null,
      previousPlan: null,
    };
    repo.seedLead(lead);
    const uc = new ListRecaptureLeads(repo, new InMemoryContractRepository());
    const result = await uc.execute({});
    const dto = result.data[0]!;
    expect(dto.assigneeId).toBe('user-42');
    expect(dto.assigneeName).toBe('María López');
  });

  it('getById() returns assigneeName=null when unassigned', async () => {
    const repo = makeRepo();
    const lead = await repo.create({ source: 'csv', contactName: 'Solo' });
    const uc = new GetRecaptureLead(repo);
    const dto = await uc.execute(lead.id);
    expect(dto).toHaveProperty('assigneeName', null);
  });

  it('getById() passes assigneeName through when pre-seeded', async () => {
    const repo = makeRepo();
    const lead: RecaptureLead = {
      id: 'lead-detail-assignee',
      source: 'csv',
      clientId: null,
      contactName: 'Detalle',
      phone: null,
      email: null,
      status: 'en_gestion',
      assigneeId: 'user-7',
      assigneeName: 'Carlos Ruiz',
      claimedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      address: null,
      churnReason: null,
      previousPlan: null,
    };
    repo.seedLead(lead);
    const uc = new GetRecaptureLead(repo);
    const dto = await uc.execute(lead.id);
    expect(dto.assigneeName).toBe('Carlos Ruiz');
  });
});

// ─── #4 — source filter ───────────────────────────────────────────────────────

describe('#4 — source filter in ListRecaptureLeads', () => {
  async function seedMixed(repo: InMemoryRecaptureRepository) {
    await repo.create({ source: 'churned_client', clientId: 'c-1', contactName: 'Churned 1' });
    await repo.create({ source: 'churned_client', clientId: 'c-2', contactName: 'Churned 2' });
    await repo.create({ source: 'csv', contactName: 'CSV Lead 1' });
    await repo.create({ source: 'csv', contactName: 'CSV Lead 2' });
    await repo.create({ source: 'csv', contactName: 'CSV Lead 3' });
  }

  it('returns only csv leads when source=csv', async () => {
    const repo = makeRepo();
    await seedMixed(repo);
    const uc = new ListRecaptureLeads(repo, new InMemoryContractRepository());
    const result = await uc.execute({ source: 'csv' });
    expect(result.total).toBe(3);
    result.data.forEach((d) => expect(d.source).toBe('csv'));
  });

  it('returns only churned_client leads when source=churned_client', async () => {
    const repo = makeRepo();
    await seedMixed(repo);
    const uc = new ListRecaptureLeads(repo, new InMemoryContractRepository());
    const result = await uc.execute({ source: 'churned_client' });
    expect(result.total).toBe(2);
    result.data.forEach((d) => expect(d.source).toBe('churned_client'));
  });

  it('returns all leads when source is omitted', async () => {
    const repo = makeRepo();
    await seedMixed(repo);
    const uc = new ListRecaptureLeads(repo, new InMemoryContractRepository());
    const result = await uc.execute({});
    expect(result.total).toBe(5);
  });

  it('source filter combines correctly with status filter', async () => {
    const repo = makeRepo();
    await seedMixed(repo);
    const leads = await repo.list({});
    // Advance the first csv lead to 'contactado'
    const csvLead = leads.data.find((l) => l.source === 'csv')!;
    await repo.updateStatus(csvLead.id, 'contactado');

    const uc = new ListRecaptureLeads(repo, new InMemoryContractRepository());
    const result = await uc.execute({ source: 'csv', status: 'contactado' });
    expect(result.total).toBe(1);
    expect(result.data[0]!.status).toBe('contactado');
    expect(result.data[0]!.source).toBe('csv');
  });
});

// ─── advanceStatus contract ───────────────────────────────────────────────────

describe('advanceStatus — contract: explicit RecaptureLeadStatus string', () => {
  it('advances lead status to contactado when advanceStatus=contactado', async () => {
    const repo = makeRepo();
    const lead = await repo.create({ source: 'csv', contactName: 'Test Advance' });
    const uc = new AddRecaptureContact(repo);
    await uc.execute({
      leadId: lead.id,
      actorId: 'user-1',
      channel: 'llamada',
      outcome: 'contactado',
      advanceStatus: 'contactado',
    });
    const updated = await repo.getById(lead.id);
    expect(updated!.status).toBe('contactado');
  });

  it('leaves status unchanged when advanceStatus is omitted', async () => {
    const repo = makeRepo();
    const lead = await repo.create({ source: 'csv', contactName: 'No Advance' });
    const uc = new AddRecaptureContact(repo);
    await uc.execute({
      leadId: lead.id,
      actorId: 'user-1',
      channel: 'whatsapp',
      outcome: 'sin_respuesta',
      // no advanceStatus
    });
    const updated = await repo.getById(lead.id);
    expect(updated!.status).toBe('nuevo');
  });

  it('advances status to recuperado (full flow)', async () => {
    const repo = makeRepo();
    const lead = await repo.create({ source: 'churned_client', contactName: 'Recuperado' });
    const uc = new AddRecaptureContact(repo);
    await uc.execute({
      leadId: lead.id,
      actorId: 'user-2',
      channel: 'email',
      outcome: 'recuperado',
      advanceStatus: 'recuperado',
    });
    const updated = await repo.getById(lead.id);
    expect(updated!.status).toBe('recuperado');
  });
});
