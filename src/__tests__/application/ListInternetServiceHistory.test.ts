/**
 * TDD — ListInternetServiceHistory (internet-history).
 *
 * GLOBAL history of INTERNET service events (mirror of ListTvActivationHistory for TV).
 *
 * CRITICAL: must return ONLY events of the INTERNET service — never TV nor any other
 * service. INTERNET is identified by ServiceCatalog.name === 'INTERNET'; the use case
 * resolves its catalog id via ServiceCatalogRepository.getByName('INTERNET') and passes
 * it as the serviceCatalogId filter to the repo.
 *
 * Uses in-memory adapters (real use case, no mocks of Prisma).
 */
import { ListInternetServiceHistory } from '@application/use-cases/ListInternetServiceHistory';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';

async function setup(opts?: { now?: () => Date }) {
  const catalog = new InMemoryServiceCatalogRepository();
  const internet = await catalog.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
  const tv = await catalog.create({ name: 'TV', label: 'TV', sortOrder: 1 });
  const eventRepo = new InMemoryContractServiceEventRepository(opts);
  // internet-history-plan-direction — catálogo de planes para derivar upgrade/downgrade por kbps.
  // IP-30M-PROMO comparte los 30000 kbps de IP-30M (kbps iguales → dirección null).
  // IP-REDUCCION / IP-BAJA son códigos de ENFORCEMENT (siempre dirección null aunque el kbps difiera).
  const planRepo = new InMemoryPlanRepository();
  await planRepo.upsertByCode({ code: 'IP-30M',       name: '30M', category: 'IP', downloadKbps: 30000,  uploadKbps: 10000 });
  await planRepo.upsertByCode({ code: 'IP-30M-PROMO', name: '30M', category: 'IP', downloadKbps: 30000,  uploadKbps: 10000 });
  await planRepo.upsertByCode({ code: 'IP-50M',       name: '50M', category: 'IP', downloadKbps: 50000,  uploadKbps: 15000 });
  await planRepo.upsertByCode({ code: 'IP-100M',      name: '100M', category: 'IP', downloadKbps: 100000, uploadKbps: 30000 });
  await planRepo.upsertByCode({ code: 'IP-REDUCCION', name: 'Reducción', category: 'IP', downloadKbps: 256, uploadKbps: 256 });
  await planRepo.upsertByCode({ code: 'IP-BAJA',      name: 'Baja', category: 'IP', downloadKbps: 0, uploadKbps: 0 });
  const useCase = new ListInternetServiceHistory(eventRepo, catalog, planRepo);
  return { catalog, internet, tv, eventRepo, planRepo, useCase };
}

describe('ListInternetServiceHistory — global internet history (internet-history)', () => {
  it('returns empty array when there are no events', async () => {
    const { useCase } = await setup();
    const res = await useCase.execute({});
    expect(res).toEqual([]);
  });

  it('returns ONLY internet events — excludes TV and other-service events', async () => {
    const { useCase, eventRepo, internet, tv } = await setup();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: tv.id, eventType: 'activated', actorName: 'Op' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: 'other-svc', eventType: 'activated', actorName: 'Op' });

    const res = await useCase.execute({});
    expect(res).toHaveLength(1);
    expect(res[0]!.serviceCatalogId).toBe(internet.id);
    expect(res.every(e => e.serviceCatalogId === internet.id)).toBe(true);
  });

  it('returns empty array when the INTERNET catalog entry is missing (no events leak)', async () => {
    const catalog = new InMemoryServiceCatalogRepository();
    await catalog.create({ name: 'TV', label: 'TV', sortOrder: 0 });
    const eventRepo = new InMemoryContractServiceEventRepository();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: 'whatever', eventType: 'activated', actorName: 'Op' });
    const useCase = new ListInternetServiceHistory(eventRepo, catalog, new InMemoryPlanRepository());

    const res = await useCase.execute({});
    expect(res).toEqual([]);
  });

  it('orders events newest-first', async () => {
    let tick = 0;
    const times = [
      new Date('2026-07-21T09:00:00.000Z'),
      new Date('2026-07-21T10:00:00.000Z'),
    ];
    const { useCase, eventRepo, internet } = await setup({ now: () => times[tick++]! });
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'deactivated', actorName: 'Op' });

    const res = await useCase.execute({});
    expect(res).toHaveLength(2);
    expect(res[0]!.eventType).toBe('deactivated'); // newest first
    expect(res[1]!.eventType).toBe('activated');
  });

  it('filters by actorId', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a1', actorName: 'Op1' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a2', actorName: 'Op2' });

    const res = await useCase.execute({ actorId: 'a1' });
    expect(res).toHaveLength(1);
    expect(res[0]!.actorId).toBe('a1');
  });

  it('filters by clientId (customerId alias)', async () => {
    const { useCase, eventRepo, internet } = await setup();
    eventRepo.setContractClient('ct-1', 'client-1', 'Alice');
    eventRepo.setContractClient('ct-2', 'client-2', 'Bob');
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });

    const res = await useCase.execute({ customerId: 'client-1' });
    expect(res).toHaveLength(1);
    expect(res[0]!.clientId).toBe('client-1');
    expect(res[0]!.customerName).toBe('Alice');
  });

  it('filters by from/to date range', async () => {
    let tick = 0;
    const times = [
      new Date('2026-07-20T10:00:00.000Z'),
      new Date('2026-07-22T10:00:00.000Z'),
    ];
    const { useCase, eventRepo, internet } = await setup({ now: () => times[tick++]! });
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'deactivated', actorName: 'Op' });

    const res = await useCase.execute({ from: new Date('2026-07-21T00:00:00.000Z') });
    expect(res).toHaveLength(1);
    expect(res[0]!.eventType).toBe('deactivated');
  });

  it('maps to the InternetServiceEventDto shape (with client + reason)', async () => {
    const { useCase, eventRepo, internet } = await setup();
    eventRepo.setContractClient('ct-1', 'client-1', 'Alice');
    await eventRepo.record({
      contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'deactivated',
      actorId: 'a1', actorName: 'Operator', reason: 'falta de pago',
    });

    const res = await useCase.execute({});
    const dto = res[0]!;
    expect(dto).toMatchObject({
      contractId: 'ct-1',
      clientId: 'client-1',
      customerName: 'Alice',
      serviceCatalogId: internet.id,
      eventType: 'deactivated',
      actorId: 'a1',
      actorName: 'Operator',
      reason: 'falta de pago',
    });
    expect(typeof dto.id).toBe('string');
    expect(typeof dto.createdAt).toBe('string');
    // No password leaks into the wire contract.
    expect((dto as unknown as Record<string, unknown>)['password']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// internet-history-plan-direction — derivación de dirección (upgrade/downgrade/null)
// ════════════════════════════════════════════════════════════════════════════
describe('ListInternetServiceHistory — plan change direction (internet-history-plan-direction)', () => {
  async function recordModified(
    eventRepo: InMemoryContractServiceEventRepository,
    internetId: string,
    oldPlan: string | null,
    newPlan: string | null,
    contractId = 'ct-1',
  ) {
    await eventRepo.record({
      contractId, serviceCatalogId: internetId, eventType: 'modified', actorName: 'Op',
      notes: `${oldPlan ?? '—'} → ${newPlan ?? '—'}`, oldPlan, newPlan,
    });
  }

  it('derives direction=upgrade when newPlan kbps > oldPlan kbps', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await recordModified(eventRepo, internet.id, 'IP-30M', 'IP-50M');
    const res = await useCase.execute({});
    expect(res[0]!.direction).toBe('upgrade');
    expect(res[0]!.oldPlan).toBe('IP-30M');
    expect(res[0]!.newPlan).toBe('IP-50M');
  });

  it('derives direction=downgrade when newPlan kbps < oldPlan kbps', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await recordModified(eventRepo, internet.id, 'IP-100M', 'IP-50M');
    const res = await useCase.execute({});
    expect(res[0]!.direction).toBe('downgrade');
  });

  it('direction=null when kbps are equal (lateral change)', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await recordModified(eventRepo, internet.id, 'IP-30M', 'IP-30M-PROMO');
    const res = await useCase.execute({});
    expect(res[0]!.direction).toBeNull();
  });

  it('direction=null when either plan is an ENFORCEMENT plan (IP-REDUCCION / IP-BAJA)', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await recordModified(eventRepo, internet.id, 'IP-50M', 'IP-REDUCCION', 'ct-a');
    await recordModified(eventRepo, internet.id, 'IP-BAJA', 'IP-50M', 'ct-b');
    const res = await useCase.execute({});
    expect(res.every(e => e.direction === null)).toBe(true);
  });

  it('direction=null when a plan code is missing from the catalog', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await recordModified(eventRepo, internet.id, 'IP-30M', 'IP-UNKNOWN');
    const res = await useCase.execute({});
    expect(res[0]!.direction).toBeNull();
  });

  it('direction=null for non-modified events (activated/deactivated)', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });
    const res = await useCase.execute({});
    expect(res[0]!.direction).toBeNull();
    expect(res[0]!.oldPlan).toBeNull();
    expect(res[0]!.newPlan).toBeNull();
  });

  // ── filtro eventType (tópico) — push-down al port ──────────────────────────
  it('filters by eventType (tópico) and pushes it down to the repo filter', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });
    await recordModified(eventRepo, internet.id, 'IP-30M', 'IP-50M', 'ct-2');

    const res = await useCase.execute({ eventType: 'modified' });
    expect(res).toHaveLength(1);
    expect(res[0]!.eventType).toBe('modified');
    expect(eventRepo.lastListFilter()?.eventType).toBe('modified'); // push-down
  });

  // ── filtro direction — in-memory tras derivar, INDEPENDIENTE de modified ──
  it('filters by direction=upgrade (excludes downgrade, lateral and non-modified)', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await eventRepo.record({ contractId: 'ct-0', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });
    await recordModified(eventRepo, internet.id, 'IP-30M', 'IP-50M', 'ct-up');    // upgrade
    await recordModified(eventRepo, internet.id, 'IP-100M', 'IP-50M', 'ct-down'); // downgrade

    const res = await useCase.execute({ direction: 'upgrade' });
    expect(res).toHaveLength(1);
    expect(res[0]!.direction).toBe('upgrade');
    expect(res[0]!.oldPlan).toBe('IP-30M');
  });

  it('filters by direction=downgrade', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await recordModified(eventRepo, internet.id, 'IP-30M', 'IP-50M', 'ct-up');
    await recordModified(eventRepo, internet.id, 'IP-100M', 'IP-50M', 'ct-down');

    const res = await useCase.execute({ direction: 'downgrade' });
    expect(res).toHaveLength(1);
    expect(res[0]!.direction).toBe('downgrade');
  });
});
