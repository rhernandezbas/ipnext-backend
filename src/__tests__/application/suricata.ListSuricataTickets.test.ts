/**
 * suricata-tickets-mirror (Phase F, task F.1, spec `suricata-tickets-ui`
 * UI-1, design D3/D13) — `ListSuricataTickets` against InMemory ports (repo
 * convention: never mock Prisma). Each filter — status/priority/area/
 * assignee/botState — is exercised independently, plus pagination and
 * sorting.
 */
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataVerdictRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataVerdictRepository';
import { InMemorySuricataAreaRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAreaRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { ListSuricataTickets } from '@application/use-cases/suricata/ListSuricataTickets';

async function seed() {
  const tickets = new InMemorySuricataTicketRepository();
  const verdicts = new InMemorySuricataVerdictRepository();
  const areas = new InMemorySuricataAreaRepository();
  const users = new InMemoryRbacUserRepository();

  const [area] = await areas.upsertMany([{ externalId: 'area-1', name: 'Soporte Técnico', syncedAt: '2026-09-10T00:00:00.000Z' }]);
  const agent = await users.create({ name: 'Ana Agente', email: 'ana@x.com', login: 'ana', passwordHash: 'h', status: 'active' });

  const mk = (over: Partial<Parameters<InMemorySuricataTicketRepository['upsertByExternalId']>[0]> & { externalId: string }) =>
    tickets.upsertByExternalId({
      subject: 'Sin internet',
      status: 'abierto',
      priority: 'alta',
      areaId: null,
      customerName: 'Cliente',
      customerEmail: null,
      customerPhone: null,
      externalClientRef: null,
      clientId: null,
      openedAt: '2026-09-01T00:00:00.000Z',
      lastMessageAt: '2026-09-01T00:00:00.000Z',
      contentHash: 'hash-v1',
      syncedAt: '2026-09-01T00:00:00.000Z',
      ...over,
    });

  // sin_analizar — no verdict.
  const tNoVerdict = await mk({ externalId: 'ext-1', status: 'abierto', priority: 'alta', lastMessageAt: '2026-09-01T10:00:00.000Z' });
  // resuelto_bot — fresh verdict, resuelto:true.
  const tResuelto = await mk({ externalId: 'ext-2', status: 'cerrado', priority: 'baja', areaId: area!.id, lastMessageAt: '2026-09-03T10:00:00.000Z' });
  await verdicts.create({ ticketId: tResuelto.id, resuelto: true, analisis: 'ok', motivo: null, respuestaSugerida: null, ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });
  // requiere_humano — fresh verdict, resuelto:false.
  const tHumano = await mk({ externalId: 'ext-3', status: 'abierto', priority: 'alta', lastMessageAt: '2026-09-02T10:00:00.000Z' });
  await verdicts.create({ ticketId: tHumano.id, resuelto: false, analisis: 'no pude', motivo: 'falta info', respuestaSugerida: 'pedir datos', ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });
  await tickets.setAssignee(tHumano.id, agent.id);
  // stale — verdict's ticketContentHash no longer matches the ticket's current hash.
  const tStale = await mk({ externalId: 'ext-4', status: 'abierto', priority: 'alta', contentHash: 'hash-v2', lastMessageAt: '2026-09-04T10:00:00.000Z' });
  await verdicts.create({ ticketId: tStale.id, resuelto: true, analisis: 'viejo', motivo: null, respuestaSugerida: null, ticketContentHash: 'hash-v1', submittedBy: 'api-suricata' });

  const useCase = new ListSuricataTickets(tickets, verdicts, areas, users);
  return { useCase, tickets, area: area!, agent, tNoVerdict, tResuelto, tHumano, tStale };
}

describe('ListSuricataTickets', () => {
  it('UI-1 — no filters returns every ticket, sorted by lastMessageAt DESC', async () => {
    const { useCase, tStale, tResuelto, tHumano, tNoVerdict } = await seed();
    const result = await useCase.execute();
    expect(result.total).toBe(4);
    expect(result.data.map((t) => t.id)).toEqual([tStale.id, tResuelto.id, tHumano.id, tNoVerdict.id]);
  });

  it('filters by status', async () => {
    const { useCase } = await seed();
    const result = await useCase.execute({ filters: { status: 'cerrado' } });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.status).toBe('cerrado');
  });

  it('filters by priority', async () => {
    const { useCase } = await seed();
    const result = await useCase.execute({ filters: { priority: 'baja' } });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.priority).toBe('baja');
  });

  it('filters by areaId and resolves areaName', async () => {
    const { useCase, area, tResuelto } = await seed();
    const result = await useCase.execute({ filters: { areaId: area.id } });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe(tResuelto.id);
    expect(result.data[0]?.areaName).toBe('Soporte Técnico');
  });

  it('filters by assigneeId and resolves assigneeName', async () => {
    const { useCase, agent, tHumano } = await seed();
    const result = await useCase.execute({ filters: { assigneeId: agent.id } });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe(tHumano.id);
    expect(result.data[0]?.assigneeName).toBe('Ana Agente');
  });

  it('UI-1 scenario — filter by bot state "requiere_humano" shows only resuelto:false current verdicts', async () => {
    const { useCase, tHumano } = await seed();
    const result = await useCase.execute({ filters: { botState: 'requiere_humano' } });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe(tHumano.id);
  });

  it('botState "resuelto_bot" excludes stale verdicts even when resuelto:true', async () => {
    const { useCase, tResuelto } = await seed();
    const result = await useCase.execute({ filters: { botState: 'resuelto_bot' } });
    expect(result.data.map((t) => t.id)).toEqual([tResuelto.id]);
  });

  it('botState "stale" isolates the outdated verdict', async () => {
    const { useCase, tStale } = await seed();
    const result = await useCase.execute({ filters: { botState: 'stale' } });
    expect(result.data.map((t) => t.id)).toEqual([tStale.id]);
  });

  it('botState "sin_analizar" isolates the never-analyzed ticket', async () => {
    const { useCase, tNoVerdict } = await seed();
    const result = await useCase.execute({ filters: { botState: 'sin_analizar' } });
    expect(result.data.map((t) => t.id)).toEqual([tNoVerdict.id]);
  });

  it('paginates the already-filtered set', async () => {
    const { useCase } = await seed();
    const page1 = await useCase.execute({ page: 1, limit: 2 });
    const page2 = await useCase.execute({ page: 2, limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page2.data).toHaveLength(2);
    expect(page1.total).toBe(4);
    expect(page2.total).toBe(4);
    expect(page1.data.map((t) => t.id)).not.toEqual(page2.data.map((t) => t.id));
  });
});
