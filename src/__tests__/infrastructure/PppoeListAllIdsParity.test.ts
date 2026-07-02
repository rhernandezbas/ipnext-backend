/**
 * PARITY TEST — pppoe-bulk-select-filter (v2), task 1.5. The guardrail against risk #1
 * of the change ("drift list↔ids"): the operador selecciona un conjunto DISTINTO al que
 * ve listado. For the SAME seed and the SAME filter, sweeping ALL pages of
 * `listAllPaginated` and collecting every id MUST produce the EXACT same SET of ids as
 * `listAllIds` — no missing, no extra.
 *
 * Uses InMemoryPppoeServiceRepository (real filtering logic, no mocks). The Prisma-side
 * guardrail (same `where` object for both methods) is covered separately by
 * `PrismaPppoeServiceRepository.listAllWhere.test.ts` (tasks 1.2/1.3) — that test proves
 * WHERE parity BY CONSTRUCTION (shared `buildListAllWhere`). This file proves BEHAVIORAL
 * parity: the actual sets of matched rows are identical for every filter and combination.
 */
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import type { PppoeDisplayStatus } from '@domain/entities/pppoeService';

const PAGE_SIZE = 5; // deliberately small vs. the seed (47 rows) so the sweep spans MANY pages

interface Filter {
  search?: string;
  displayStatus?: PppoeDisplayStatus;
  nasId?: string;
  includeUnassigned?: boolean;
  /** pppoe-preprovision D6.7: solo pendientes de instalación (nasId IS NULL). */
  pendingOnly?: boolean;
}

async function sweepAllIds(repo: InMemoryPppoeServiceRepository, filter: Filter): Promise<{ ids: string[]; total: number }> {
  const collected: string[] = [];
  let page = 1;
  let total = 0;
  for (;;) {
    const res = await repo.listAllPaginated({ page, pageSize: PAGE_SIZE, ...filter });
    total = res.total;
    collected.push(...res.data.map(d => d.id));
    if (page * PAGE_SIZE >= res.total) break;
    page += 1;
  }
  return { ids: collected, total };
}

function asSortedSet(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

async function seed(repo: InMemoryPppoeServiceRepository) {
  const ids: Record<string, string> = {};

  // 20 "active" services spread across 2 NAS, WITH contract (the normal case).
  for (let i = 0; i < 20; i++) {
    const nasId = i % 2 === 0 ? 'NE8000-1' : 'NE8000-2';
    const username = `cliente${i}@test`;
    const s = await repo.upsertByUsername({
      username, password: 'x', nasId, status: 'enabled', enforcedState: 'active', contractId: `ct-${i}`,
      remoteAddress: `100.64.${i}.1`,
    });
    ids[username] = s.id;
  }
  // 10 "reduced" (deudores) on NE8000-1.
  for (let i = 0; i < 10; i++) {
    const username = `deudor${i}@test`;
    const s = await repo.upsertByUsername({
      username, password: 'x', nasId: 'NE8000-1', status: 'enabled', enforcedState: 'reduced', contractId: `ct-red-${i}`,
    });
    ids[username] = s.id;
  }
  // 5 "blocked" (baja de servicio, secret disabled) on NE8000-2.
  for (let i = 0; i < 5; i++) {
    const username = `bloqueado${i}@test`;
    const s = await repo.upsertByUsername({
      username, password: 'x', nasId: 'NE8000-2', status: 'disabled', enforcedState: 'active', contractId: `ct-blk-${i}`,
    });
    ids[username] = s.id;
  }
  // 4 "baja" (terminated) — should never appear unless displayStatus=baja is requested.
  for (let i = 0; i < 4; i++) {
    const username = `baja${i}@test`;
    const s = await repo.upsertByUsername({
      username, password: 'x', nasId: 'NE8000-1', status: 'terminated', enforcedState: 'active', contractId: `ct-baja-${i}`,
    });
    ids[username] = s.id;
  }
  // 5 "juan*" services with a distinctive search prefix, on NE8000-1, active.
  for (let i = 0; i < 5; i++) {
    const username = `juan${i}@test`;
    const s = await repo.upsertByUsername({
      username, password: 'x', nasId: 'NE8000-1', status: 'enabled', enforcedState: 'active', contractId: `ct-juan-${i}`,
    });
    ids[username] = s.id;
  }
  // 3 orphan rows (contractId=null) — must NEVER appear unless includeUnassigned=true.
  for (let i = 0; i < 3; i++) {
    const username = `huerfano${i}`;
    const s = await repo.upsertByUsername({ username, password: 'x', nasId: 'NE8000-1', contractId: null });
    ids[username] = s.id;
  }
  // 1 row with a MAC callerId, matched by MAC search.
  const macRow = await repo.upsertByUsername({
    username: 'con-mac@test', password: 'x', nasId: 'NE8000-2', status: 'enabled', enforcedState: 'active', contractId: 'ct-mac-1',
  });
  await repo.setCallerId(macRow.id, 'aa:bb:cc:dd:ee:ff');
  ids['con-mac@test'] = macRow.id;

  return ids;
}

describe('Paridad list↔ids (pppoe-bulk-select-filter v2, task 1.5) — mismo seed, mismo filtro → mismo SET de ids', () => {
  let repo: InMemoryPppoeServiceRepository;

  beforeEach(async () => {
    repo = new InMemoryPppoeServiceRepository();
    await seed(repo);
  });

  it('sin filtro (solo includeUnassigned=true): paridad exacta + total coincide', async () => {
    const swept = await sweepAllIds(repo, { includeUnassigned: true });
    const direct = await repo.listAllIds({ includeUnassigned: true });

    expect(direct.ids.length).toBe(direct.total);
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
    expect(direct.total).toBe(swept.total);
    // 20 + 10 + 5 + 4 + 5 + 3 + 1 = 48 filas totales sembradas
    expect(direct.total).toBe(48);
  });

  it('por nasId: paridad exacta', async () => {
    const swept = await sweepAllIds(repo, { nasId: 'NE8000-1', includeUnassigned: true });
    const direct = await repo.listAllIds({ nasId: 'NE8000-1', includeUnassigned: true });

    expect(direct.ids.length).toBe(direct.total);
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
    expect(direct.total).toBe(swept.total);
  });

  it('por search (username): paridad exacta', async () => {
    const swept = await sweepAllIds(repo, { search: 'juan', includeUnassigned: true });
    const direct = await repo.listAllIds({ search: 'juan', includeUnassigned: true });

    expect(direct.total).toBe(5); // juan0..juan4
    expect(direct.ids.length).toBe(direct.total);
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('por search (IP): paridad exacta', async () => {
    const swept = await sweepAllIds(repo, { search: '100.64.1', includeUnassigned: true });
    const direct = await repo.listAllIds({ search: '100.64.1', includeUnassigned: true });

    expect(direct.ids.length).toBe(direct.total);
    expect(direct.total).toBeGreaterThan(0);
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('por search (MAC): paridad exacta', async () => {
    const swept = await sweepAllIds(repo, { search: 'aabbccddeeff', includeUnassigned: true });
    const direct = await repo.listAllIds({ search: 'aabbccddeeff', includeUnassigned: true });

    expect(direct.total).toBe(1);
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('por displayStatus (reduced): paridad exacta', async () => {
    const swept = await sweepAllIds(repo, { displayStatus: 'reduced', includeUnassigned: true });
    const direct = await repo.listAllIds({ displayStatus: 'reduced', includeUnassigned: true });

    expect(direct.total).toBe(10);
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('por displayStatus (blocked): paridad exacta', async () => {
    const swept = await sweepAllIds(repo, { displayStatus: 'blocked', includeUnassigned: true });
    const direct = await repo.listAllIds({ displayStatus: 'blocked', includeUnassigned: true });

    expect(direct.total).toBe(5);
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('por displayStatus (baja): paridad exacta', async () => {
    const swept = await sweepAllIds(repo, { displayStatus: 'baja', includeUnassigned: true });
    const direct = await repo.listAllIds({ displayStatus: 'baja', includeUnassigned: true });

    expect(direct.total).toBe(4);
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('combinación search+nasId: paridad exacta', async () => {
    const filter = { search: 'juan', nasId: 'NE8000-1', includeUnassigned: true };
    const swept = await sweepAllIds(repo, filter);
    const direct = await repo.listAllIds(filter);

    expect(direct.total).toBe(5); // all juan* rows are on NE8000-1
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('combinación nasId+displayStatus: paridad exacta', async () => {
    const filter = { nasId: 'NE8000-1', displayStatus: 'reduced' as PppoeDisplayStatus, includeUnassigned: true };
    const swept = await sweepAllIds(repo, filter);
    const direct = await repo.listAllIds(filter);

    expect(direct.total).toBe(10); // all deudor* rows are on NE8000-1
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('combinación search+nasId+displayStatus (triple AND): paridad exacta', async () => {
    const filter = { search: 'juan', nasId: 'NE8000-1', displayStatus: 'active' as PppoeDisplayStatus, includeUnassigned: true };
    const swept = await sweepAllIds(repo, filter);
    const direct = await repo.listAllIds(filter);

    expect(direct.total).toBe(5); // juan0..juan4 are active
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('default (includeUnassigned omitido): huérfanos EXCLUIDOS en ambos métodos por igual', async () => {
    const swept = await sweepAllIds(repo, {});
    const direct = await repo.listAllIds({});

    expect(direct.total).toBe(45); // 48 - 3 huérfanos
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('filtro sin matches: ambos devuelven conjunto vacío (paridad en el caso borde)', async () => {
    const filter = { nasId: 'NAS-INEXISTENTE', includeUnassigned: true };
    const swept = await sweepAllIds(repo, filter);
    const direct = await repo.listAllIds(filter);

    expect(direct.total).toBe(0);
    expect(direct.ids).toEqual([]);
    expect(swept.ids).toEqual([]);
  });
});

describe('Paridad list↔ids — pendingOnly (pppoe-preprovision D6.7): chip Pendientes server-side', () => {
  let repo: InMemoryPppoeServiceRepository;

  beforeEach(async () => {
    repo = new InMemoryPppoeServiceRepository();
    await seed(repo);
    // Pendientes de instalación (nasId null): 2 con contrato + 1 huérfano.
    await repo.upsertByUsername({
      username: 'pendiente-a@test', password: 'x', nasId: null, status: 'enabled',
      enforcedState: 'active', contractId: 'ct-pend-a',
    });
    await repo.upsertByUsername({
      username: 'pendiente-b@test', password: 'x', nasId: null, status: 'enabled',
      enforcedState: 'active', contractId: 'ct-pend-b',
    });
    await repo.upsertByUsername({
      username: 'pendiente-huerfano', password: 'x', nasId: null, contractId: null,
    });
  });

  it('pendingOnly=true: paridad exacta y SOLO filas nasId null (con contrato, default)', async () => {
    const filter = { pendingOnly: true };
    const swept = await sweepAllIds(repo, filter);
    const direct = await repo.listAllIds(filter);

    expect(direct.total).toBe(2); // el huérfano queda fuera sin includeUnassigned
    expect(direct.ids.length).toBe(direct.total);
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('pendingOnly=true + includeUnassigned=true: el pendiente huérfano entra en AMBOS por igual', async () => {
    const filter = { pendingOnly: true, includeUnassigned: true };
    const swept = await sweepAllIds(repo, filter);
    const direct = await repo.listAllIds(filter);

    expect(direct.total).toBe(3);
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('pendingOnly combinado con search: paridad exacta (AND compositivo)', async () => {
    const filter = { pendingOnly: true, search: 'pendiente-a', includeUnassigned: true };
    const swept = await sweepAllIds(repo, filter);
    const direct = await repo.listAllIds(filter);

    expect(direct.total).toBe(1);
    expect(asSortedSet(direct.ids)).toEqual(asSortedSet(swept.ids));
  });

  it('sin pendingOnly: los pendientes se listan junto al resto (regresión — el filtro es opt-in)', async () => {
    const direct = await repo.listAllIds({ includeUnassigned: true });
    expect(direct.total).toBe(51); // 48 del seed base + 3 pendientes
  });
});
