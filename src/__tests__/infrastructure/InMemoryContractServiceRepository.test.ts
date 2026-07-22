import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { ContractServiceDuplicateError } from '@domain/errors/contractServices';

describe('InMemoryContractServiceRepository (port parity)', () => {
  let repo: InMemoryContractServiceRepository;

  beforeEach(() => {
    repo = new InMemoryContractServiceRepository();
    repo.catalog['S1'] = { name: 'INTERNET', label: 'Internet' };
    repo.catalog['S2'] = { name: 'TV', label: null };
  });

  it('add returns a joined view with catalog name/label and default status active', async () => {
    const cs = await repo.add({ contractId: 'C', serviceCatalogId: 'S1', notes: 'p' });
    expect(cs.id).toBeTruthy();
    expect(cs.contractId).toBe('C');
    expect(cs.serviceCatalogId).toBe('S1');
    expect(cs.name).toBe('INTERNET');
    expect(cs.label).toBe('Internet');
    expect(cs.status).toBe('active');
    expect(cs.notes).toBe('p');
  });

  // W-2 — parity with the Prisma UNIQUE(contractId, serviceCatalogId): adding a
  // duplicate pair must throw ContractServiceDuplicateError (mirrors P2002 mapping).
  it('add throws ContractServiceDuplicateError on a duplicate (contractId, serviceCatalogId) pair', async () => {
    await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    await expect(repo.add({ contractId: 'C', serviceCatalogId: 'S1' })).rejects.toBeInstanceOf(
      ContractServiceDuplicateError,
    );
  });

  it('add allows the same catalog on a different contract', async () => {
    await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    const other = await repo.add({ contractId: 'OTHER', serviceCatalogId: 'S1' });
    expect(other.contractId).toBe('OTHER');
  });

  it('getById returns the view or null', async () => {
    const cs = await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    expect((await repo.getById(cs.id))?.id).toBe(cs.id);
    expect(await repo.getById('nope')).toBeNull();
  });

  it('getByPair finds by (contractId, serviceCatalogId)', async () => {
    await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    expect(await repo.getByPair('C', 'S1')).not.toBeNull();
    expect(await repo.getByPair('C', 'S2')).toBeNull();
    expect(await repo.getByPair('OTHER', 'S1')).toBeNull();
  });

  it('update patches status/notes and returns null for unknown id', async () => {
    const cs = await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    const updated = await repo.update(cs.id, { status: 'inactive', notes: 'x' });
    expect(updated?.status).toBe('inactive');
    expect(updated?.notes).toBe('x');
    expect(await repo.update('nope', { status: 'inactive' })).toBeNull();
  });

  it('delete removes the row and returns false for unknown id', async () => {
    const cs = await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    expect(await repo.delete(cs.id)).toBe(true);
    expect(await repo.getById(cs.id)).toBeNull();
    expect(await repo.delete('nope')).toBe(false);
  });

  // service-transfer fix wave (MEDIUM-1) — el método devuelve TODAS las filas activas candidatas
  // (no un findFirst): el caller filtra por cic EXACTO e inactiva todas las que registren el cic.
  describe('findActiveByCatalogAndNotesPrefix', () => {
    it('devuelve TODAS las filas activas del catálogo que matchean el prefijo, más viejas primero', async () => {
      const a = await repo.add({ contractId: 'C1', serviceCatalogId: 'S2', notes: 'CIC 123 · Pack A' });
      const b = await repo.add({ contractId: 'C2', serviceCatalogId: 'S2', notes: 'CIC 123 · Residuo' });
      // Fila inactiva con el mismo prefijo: NO debe aparecer.
      const c = await repo.add({ contractId: 'C3', serviceCatalogId: 'S2', notes: 'CIC 123 · Baja' });
      await repo.update(c.id, { status: 'inactive' });
      // Otro catálogo con el mismo prefijo: NO debe aparecer.
      await repo.add({ contractId: 'C1', serviceCatalogId: 'S1', notes: 'CIC 123 · Otro catálogo' });

      const rows = await repo.findActiveByCatalogAndNotesPrefix('S2', 'CIC 123');
      expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
    });

    it('colisión de prefijo: "CIC 123" también matchea "CIC 1234 · …" — devuelve AMBAS y el caller filtra por cic exacto', async () => {
      const collision = await repo.add({ contractId: 'C1', serviceCatalogId: 'S2', notes: 'CIC 1234 · Pack X' });
      const exact = await repo.add({ contractId: 'C2', serviceCatalogId: 'S2', notes: 'CIC 123 · Pack Y' });

      const rows = await repo.findActiveByCatalogAndNotesPrefix('S2', 'CIC 123');
      expect(rows.map((r) => r.id)).toEqual([collision.id, exact.id]);
    });

    it('sin matches → array vacío', async () => {
      await repo.add({ contractId: 'C1', serviceCatalogId: 'S2', notes: 'CIC 999 · Pack' });
      expect(await repo.findActiveByCatalogAndNotesPrefix('S2', 'CIC 123')).toEqual([]);
    });
  });

  // gigared-tv-identity-hardening (D4/B4) — batch owner resolver for ListGigaredAccounts
  // local-first. Exact cic match (unlike the prefix scan above), clientId resolved via the
  // injectable contractId→clientId map (mirrors setContractClient on the events repo).
  describe('findActiveTvOwnersByCics', () => {
    it('devuelve SOLO las filas activas cuyo cic EXACTO está en la lista, con el clientId del contrato', async () => {
      const withRow = await repo.add({ contractId: 'C1', serviceCatalogId: 'S2', notes: 'CIC 123 · Pack A' });
      // Otra cuenta sin fila local — no debe aparecer.
      await repo.add({ contractId: 'C2', serviceCatalogId: 'S2', notes: 'CIC 999 · Pack B' });
      repo.contractClients[withRow.contractId] = 'client-A';

      const rows = await repo.findActiveTvOwnersByCics('S2', ['123', '456']);
      expect(rows).toEqual([{ notes: 'CIC 123 · Pack A', clientId: 'client-A' }]);
    });

    it('match EXACTO — "CIC 12" NO sobre-matchea "CIC 123"', async () => {
      await repo.add({ contractId: 'C1', serviceCatalogId: 'S2', notes: 'CIC 123 · Pack A' });
      const rows = await repo.findActiveTvOwnersByCics('S2', ['12']);
      expect(rows).toEqual([]);
    });

    it('dos filas activas con el MISMO cic exacto (dirty data) — la más vieja por createdAt gana', async () => {
      const first = await repo.add({ contractId: 'C1', serviceCatalogId: 'S2', notes: 'CIC 123 · Pack A' });
      const second = await repo.add({ contractId: 'C2', serviceCatalogId: 'S2', notes: 'CIC 123 · Pack B' });
      repo.contractClients[first.contractId] = 'client-old';
      repo.contractClients[second.contractId] = 'client-new';

      const rows = await repo.findActiveTvOwnersByCics('S2', ['123']);
      expect(rows).toEqual([
        { notes: 'CIC 123 · Pack A', clientId: 'client-old' },
        { notes: 'CIC 123 · Pack B', clientId: 'client-new' },
      ]);
    });

    it('fila status:"inactive" con el cic — NO aparece (origen inactivado por transfer)', async () => {
      const row = await repo.add({ contractId: 'C1', serviceCatalogId: 'S2', notes: 'CIC 123 · Pack A' });
      await repo.update(row.id, { status: 'inactive' });
      repo.contractClients[row.contractId] = 'client-A';

      expect(await repo.findActiveTvOwnersByCics('S2', ['123'])).toEqual([]);
    });

    it('sin cics → array vacío, sin tocar las filas', async () => {
      await repo.add({ contractId: 'C1', serviceCatalogId: 'S2', notes: 'CIC 123 · Pack A' });
      expect(await repo.findActiveTvOwnersByCics('S2', [])).toEqual([]);
    });
  });
});
