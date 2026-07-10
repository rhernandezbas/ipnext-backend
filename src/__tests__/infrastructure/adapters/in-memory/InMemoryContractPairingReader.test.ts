import { InMemoryContractPairingReader } from '@infrastructure/adapters/in-memory/InMemoryContractPairingReader';
import { PairingContract } from '@domain/entities/ownershipCase';

const START = '2024-05-01T00:00:00.000Z';
const ADDRESS = 'MITRE 100';

function row(id: string, clientId: string, overrides: Partial<PairingContract> = {}): PairingContract {
  return {
    id,
    clientId,
    address: ADDRESS,
    startDate: START,
    motivoBaja: null,
    status: 'active',
    ...overrides,
  };
}

describe('InMemoryContractPairingReader', () => {
  let reader: InMemoryContractPairingReader;

  beforeEach(() => {
    reader = new InMemoryContractPairingReader();
  });

  describe('findTitularityBajas', () => {
    it('returns only bajas whose motivo contains CAMBIO DE TITULARIDAD (case-insensitive substring)', async () => {
      reader.seed(row('b1', 'c1', { status: 'baja', motivoBaja: 'CAMBIO DE TITULARIDAD' }));
      reader.seed(row('b2', 'c2', { status: 'baja', motivoBaja: 'baja por cambio de titularidad (venta)' }));
      reader.seed(row('b3', 'c3', { status: 'baja', motivoBaja: 'MIGRACION' }));
      reader.seed(row('b4', 'c4', { status: 'baja', motivoBaja: null }));
      reader.seed(row('b5', 'c5', { status: 'active', motivoBaja: 'CAMBIO DE TITULARIDAD' })); // not a baja

      const result = await reader.findTitularityBajas({ limit: 10, excludeContractIds: [] });

      expect(result.map((r) => r.id).sort()).toEqual(['b1', 'b2']);
    });

    // M2/B1: SIN ventana (el mirror no tiene updatedAt) — cap por tick con orden
    // estable (detalle determinístico; el drenaje viene de excludeContractIds).
    it('honors the limit cap with newest-first stable order', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      reader.seed(row('vieja', 'c1', { status: 'baja', motivoBaja: 'CAMBIO DE TITULARIDAD' }), twoDaysAgo);
      reader.seed(row('media', 'c2', { status: 'baja', motivoBaja: 'CAMBIO DE TITULARIDAD' }), oneDayAgo);
      reader.seed(row('nueva', 'c3', { status: 'baja', motivoBaja: 'CAMBIO DE TITULARIDAD' }));

      const result = await reader.findTitularityBajas({ limit: 2, excludeContractIds: [] });

      expect(result.map((r) => r.id)).toEqual(['nueva', 'media']);
    });

    // FIX WAVE 2 — el cap drena: las bajas ya caseadas (excludeContractIds) se
    // excluyen ANTES del cap, así el batch trae las siguientes sin caso.
    it('excludes the already-cased contract ids BEFORE applying the cap (the cap drains)', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      reader.seed(row('vieja', 'c1', { status: 'baja', motivoBaja: 'CAMBIO DE TITULARIDAD' }), twoDaysAgo);
      reader.seed(row('media', 'c2', { status: 'baja', motivoBaja: 'CAMBIO DE TITULARIDAD' }), oneDayAgo);
      reader.seed(row('nueva', 'c3', { status: 'baja', motivoBaja: 'CAMBIO DE TITULARIDAD' }));

      const result = await reader.findTitularityBajas({ limit: 2, excludeContractIds: ['nueva', 'media'] });

      expect(result.map((r) => r.id)).toEqual(['vieja']);
    });

    it('treats legacy raw "Baja" status as baja (case-insensitive status match)', async () => {
      reader.seed(row('legacy', 'c1', { status: 'Baja', motivoBaja: 'CAMBIO DE TITULARIDAD' }));

      const result = await reader.findTitularityBajas({ limit: 10, excludeContractIds: [] });

      expect(result.map((r) => r.id)).toEqual(['legacy']);
    });
  });

  // ─── H1a/H1b — lectura puntual para re-pareo y validación de set-target ─────

  describe('getContract', () => {
    it('returns the seeded contract by id', async () => {
      reader.seed(row('ct-1', 'c1', { status: 'baja', motivoBaja: 'CAMBIO DE TITULARIDAD' }));

      const result = await reader.getContract('ct-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('ct-1');
      expect(result!.clientId).toBe('c1');
      expect(result!.status).toBe('baja');
      expect(result!.address).toBe(ADDRESS);
      expect(result!.startDate).toBe(START);
    });

    it('returns null for an unknown id', async () => {
      expect(await reader.getContract('nope')).toBeNull();
    });
  });

  describe('findActivePairingCandidates', () => {
    it('returns only non-baja contracts of OTHER clients with the EXACT same startDate and address', async () => {
      reader.seed(row('match', 'c2'));
      reader.seed(row('same-client', 'c1')); // excluded: same client as the baja
      reader.seed(row('is-baja', 'c3', { status: 'baja' })); // excluded: baja
      reader.seed(row('is-raw-baja', 'c4', { status: 'Baja' })); // excluded: legacy raw baja
      reader.seed(row('other-address', 'c5', { address: 'SARMIENTO 200' })); // excluded: address mismatch
      reader.seed(row('other-start', 'c6', { startDate: '2023-01-01T00:00:00.000Z' })); // excluded: startDate mismatch

      const result = await reader.findActivePairingCandidates({
        startDate: START,
        address: ADDRESS,
        excludeClientId: 'c1',
      });

      expect(result.map((r) => r.id)).toEqual(['match']);
      expect(result[0]!.clientId).toBe('c2');
    });

    it('includes non-active non-baja statuses (blocked/inactive/new) as candidates', async () => {
      reader.seed(row('blocked', 'c2', { status: 'blocked' }));
      reader.seed(row('new', 'c3', { status: 'new' }));

      const result = await reader.findActivePairingCandidates({
        startDate: START,
        address: ADDRESS,
        excludeClientId: 'c1',
      });

      expect(result.map((r) => r.id).sort()).toEqual(['blocked', 'new']);
    });

    it('never matches contracts without address', async () => {
      reader.seed(row('no-address', 'c2', { address: null }));

      const result = await reader.findActivePairingCandidates({
        startDate: START,
        address: ADDRESS,
        excludeClientId: 'c1',
      });

      expect(result).toEqual([]);
    });
  });

  // ─── actions-worklist W2 (BAJA-1) ──────────────────────────────────────────

  describe('findRecentBajas', () => {
    it('lista solo contratos en baja (status case-insensitive, cubre raw "Baja")', async () => {
      reader.seed(row('b1', 'c1', { status: 'baja', motivoBaja: 'MUDANZA' }));
      reader.seed(row('b2', 'c2', { status: 'Baja', motivoBaja: 'DEUDA' }));
      reader.seed(row('a1', 'c3', { status: 'active', motivoBaja: 'MUDANZA' }));

      const result = await reader.findRecentBajas({ excludeTitularity: false, page: 1, pageSize: 10 });

      expect(result.items.map((r) => r.id).sort()).toEqual(['b1', 'b2']);
      expect(result.total).toBe(2);
    });

    // M3 — "reciente" honesto: motivoBaja es forward-only (solo se estampa desde
    // 2026-07-10); las bajas históricas del backfill tienen NULL → quedan FUERA.
    it('EXCLUYE las bajas con motivoBaja null (backfill histórico) — proxy forward-only de "reciente"', async () => {
      reader.seed(row('con-motivo', 'c1', { status: 'baja', motivoBaja: 'MUDANZA' }));
      reader.seed(row('historica', 'c2', { status: 'baja', motivoBaja: null }));

      const conExclusion = await reader.findRecentBajas({ excludeTitularity: true, page: 1, pageSize: 10 });
      const sinExclusion = await reader.findRecentBajas({ excludeTitularity: false, page: 1, pageSize: 10 });

      expect(conExclusion.items.map((r) => r.id)).toEqual(['con-motivo']);
      expect(conExclusion.total).toBe(1);
      expect(sinExclusion.items.map((r) => r.id)).toEqual(['con-motivo']);
      expect(sinExclusion.total).toBe(1);
    });

    it('excludeTitularity=true excluye motivo titularidad (substring case-insensitive) pero incluye otros motivos', async () => {
      reader.seed(row('titu', 'c1', { status: 'baja', motivoBaja: 'baja por cambio de titularidad (venta)' }));
      reader.seed(row('mudanza', 'c2', { status: 'baja', motivoBaja: 'MUDANZA' }));

      const result = await reader.findRecentBajas({ excludeTitularity: true, page: 1, pageSize: 10 });

      expect(result.items.map((r) => r.id)).toEqual(['mudanza']);
      expect(result.total).toBe(1);
    });

    it('excludeTitularity=false incluye también las bajas de titularidad', async () => {
      reader.seed(row('titu', 'c1', { status: 'baja', motivoBaja: 'CAMBIO DE TITULARIDAD' }));
      reader.seed(row('mudanza', 'c2', { status: 'baja', motivoBaja: 'MUDANZA' }));

      const result = await reader.findRecentBajas({ excludeTitularity: false, page: 1, pageSize: 10 });

      expect(result.items.map((r) => r.id).sort()).toEqual(['mudanza', 'titu']);
    });

    it('pagina con total estable (el total NO depende de la página)', async () => {
      reader.seed(row('b1', 'c1', { status: 'baja', motivoBaja: 'MUDANZA' }));
      reader.seed(row('b2', 'c2', { status: 'baja', motivoBaja: 'MUDANZA' }));
      reader.seed(row('b3', 'c3', { status: 'baja', motivoBaja: 'MUDANZA' }));

      const page1 = await reader.findRecentBajas({ excludeTitularity: true, page: 1, pageSize: 2 });
      const page2 = await reader.findRecentBajas({ excludeTitularity: true, page: 2, pageSize: 2 });

      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(1);
      expect(page1.total).toBe(3);
      expect(page2.total).toBe(3);
      // sin solapamiento entre páginas (orden estable)
      const ids = [...page1.items, ...page2.items].map((r) => r.id).sort();
      expect(ids).toEqual(['b1', 'b2', 'b3']);
    });

    it('orden estable: los seeds más nuevos salen primero (proxy de "reciente" — Contract no tiene updatedAt)', async () => {
      const older = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      reader.seed(row('vieja', 'c1', { status: 'baja', motivoBaja: 'MUDANZA' }), older);
      reader.seed(row('nueva', 'c2', { status: 'baja', motivoBaja: 'MUDANZA' }));

      const result = await reader.findRecentBajas({ excludeTitularity: true, page: 1, pageSize: 10 });

      expect(result.items.map((r) => r.id)).toEqual(['nueva', 'vieja']);
    });
  });
});
