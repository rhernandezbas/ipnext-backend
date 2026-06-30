/**
 * TDD — ListAllPppoeServices: `includeUnassigned` flag (pppoe-full-management Fase 1).
 *
 * Default (false/omitted): solo PPPoE CON contrato (comportamiento actual — pina InternetServicesPage).
 * true:  incluye huérfanos (contractId=null); clientId/customerName=null para ellos.
 * Combinable con nasId.
 *
 * STRICT: las tres clases tienen que compilar y pasar.
 */
import { ListAllPppoeServices } from '@application/use-cases/ListAllPppoeServices';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';

async function setup() {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const eventRepo = new InMemoryContractServiceEventRepository();
  const catalog = new InMemoryServiceCatalogRepository();
  await catalog.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
  const nasRepo = new InMemoryNasRepository();
  const useCase = new ListAllPppoeServices(pppoeRepo, eventRepo, catalog, nasRepo);
  return { pppoeRepo, eventRepo, catalog, nasRepo, useCase };
}

describe('ListAllPppoeServices — includeUnassigned flag (Fase 1)', () => {
  // ── Pin del comportamiento viejo (protege InternetServicesPage) ──
  it('default (no flag): orphans are EXCLUDED, only contracted services appear', async () => {
    const { pppoeRepo, useCase } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'orphan', password: 'x', nasId: 'nas-1', contractId: null });
    await pppoeRepo.upsertByUsername({ username: 'client', password: 'x', nasId: 'nas-1', contractId: 'ct-1' });

    const res = await useCase.execute({});
    expect(res.total).toBe(1);
    expect(res.data[0]!.username).toBe('client');
    expect(res.data.some(d => d.username === 'orphan')).toBe(false);
  });

  it('includeUnassigned=false: same as default — orphans excluded', async () => {
    const { pppoeRepo, useCase } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'orphan', password: 'x', nasId: 'nas-1', contractId: null });
    await pppoeRepo.upsertByUsername({ username: 'client', password: 'x', nasId: 'nas-1', contractId: 'ct-1' });

    const res = await useCase.execute({ includeUnassigned: false });
    expect(res.total).toBe(1);
    expect(res.data[0]!.username).toBe('client');
  });

  it('includeUnassigned=true: orphans ARE included with clientId/customerName=null', async () => {
    const { pppoeRepo, useCase } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'orphan', password: 'x', nasId: 'nas-1', contractId: null });
    await pppoeRepo.upsertByUsername({ username: 'client', password: 'x', nasId: 'nas-1', contractId: 'ct-1' });
    pppoeRepo.setContractClient('ct-1', 'cid-1', 'Juan Perez');

    const res = await useCase.execute({ includeUnassigned: true });
    expect(res.total).toBe(2);
    const orphanDto = res.data.find(d => d.username === 'orphan')!;
    expect(orphanDto).toBeDefined();
    expect(orphanDto.clientId).toBeNull();
    expect(orphanDto.customerName).toBeNull();
    expect(orphanDto.contractId).toBeNull();
    // client still has its data
    const clientDto = res.data.find(d => d.username === 'client')!;
    expect(clientDto.clientId).toBe('cid-1');
    expect(clientDto.customerName).toBe('Juan Perez');
  });

  it('includeUnassigned=true: total counts orphans too', async () => {
    const { pppoeRepo, useCase } = await setup();
    for (let i = 0; i < 3; i++) {
      await pppoeRepo.upsertByUsername({ username: `orphan${i}`, password: 'x', nasId: 'nas-1', contractId: null });
    }
    for (let i = 0; i < 2; i++) {
      await pppoeRepo.upsertByUsername({ username: `client${i}`, password: 'x', nasId: 'nas-1', contractId: `ct-${i}` });
    }

    const res = await useCase.execute({ includeUnassigned: true });
    expect(res.total).toBe(5);
  });

  it('includeUnassigned=true combined with nasId filter', async () => {
    const { pppoeRepo, useCase } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'orphan-nas1', password: 'x', nasId: 'nas-1', contractId: null });
    await pppoeRepo.upsertByUsername({ username: 'orphan-nas2', password: 'x', nasId: 'nas-2', contractId: null });
    await pppoeRepo.upsertByUsername({ username: 'client-nas1', password: 'x', nasId: 'nas-1', contractId: 'ct-1' });

    const res = await useCase.execute({ includeUnassigned: true, nasId: 'nas-1' });
    expect(res.total).toBe(2);
    expect(res.data.map(d => d.username).sort()).toEqual(['client-nas1', 'orphan-nas1']);
    expect(res.data.some(d => d.username === 'orphan-nas2')).toBe(false);
  });

  it('includeUnassigned=true: orphans have remoteAddress and ipMode in DTO', async () => {
    const { pppoeRepo, useCase } = await setup();
    await pppoeRepo.upsertByUsername({
      username: 'orphan',
      password: 'x',
      nasId: 'nas-1',
      contractId: null,
      remoteAddress: '10.0.0.5',
      ipMode: 'fixed',
    });

    const res = await useCase.execute({ includeUnassigned: true });
    const dto = res.data[0]!;
    expect(dto.remoteAddress).toBe('10.0.0.5');
    expect(dto.ipMode).toBe('fixed');
  });
});
