/**
 * Tests for InMemoryClientMirrorRepository.upsertContract behavior.
 *
 * NOTE on clientId coverage (REQ-DELTA-12):
 * The in-memory double reassigns the owner by overwriting the full contract object
 * (Map.set semantics). This test documents that behavior, BUT it does NOT prove
 * that PrismaClientMirrorRepository.upsertContract.update sets clientId correctly
 * — that is covered by the data-block pinning test in PrismaClientMirrorRepository.upsertData.test.ts.
 */
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { GrClient, GrContract } from '@domain/entities/gestionReal';

function makeClient(id: string): GrClient {
  return {
    grClienteId: id, name: `Cliente ${id}`, documento: id, email: null, phone: null,
    status: 'Activo', statusCode: '1', address: null, city: null, province: null,
    ultimaModificacion: null, fechaCreacion: null, raw: {},
  };
}

function makeContract(contratoId: string, clienteId: string): GrContract {
  return {
    grContratoId: contratoId, grClienteId: clienteId, plan: 'IP-Air-30', status: 'Vigente',
    startDate: '01-01-2025', address: null, lat: null, lng: null, pppoeUsername: null,
    modificado: '20-06-2026 10:00:00', fechaCreacion: null, vendedor: null, motivoBaja: null, raw: {},
  };
}

describe('InMemoryClientMirrorRepository.upsertContract (REQ-DELTA-12)', () => {
  it('create — new contract is stored keyed by grContratoId', async () => {
    const mirror = new InMemoryClientMirrorRepository();
    const result = await mirror.upsertContract(makeContract('900', '111'));
    expect(result.created).toBe(true);
    expect(mirror.contracts.has('900')).toBe(true);
    expect(mirror.contracts.get('900')?.grClienteId).toBe('111');
  });

  it('update — existing contract: upsert with new grClienteId reassigns owner (REQ-DELTA-12)', async () => {
    const mirror = new InMemoryClientMirrorRepository();
    // Initial: contract 900 owned by client A
    await mirror.upsertContract(makeContract('900', 'clientA'));
    expect(mirror.contracts.get('900')?.grClienteId).toBe('clientA');

    // Upsert: same grContratoId but owner changed to client B
    const result = await mirror.upsertContract(makeContract('900', 'clientB'));

    expect(result.created).toBe(false);  // update, not create
    expect(mirror.contracts.has('900')).toBe(true);
    expect(mirror.contracts.get('900')?.grClienteId).toBe('clientB');
    expect(mirror.contracts.size).toBe(1);  // no new row created
  });

  it('enforceParent=false (default) — creates contract even when client not in mirror', async () => {
    const mirror = new InMemoryClientMirrorRepository();
    // Default: enforceParent is false, so no parent check
    const result = await mirror.upsertContract(makeContract('900', 'nonexistentClient'));
    expect(result.created).toBe(true);
    expect(mirror.contracts.has('900')).toBe(true);
  });

  it('enforceParent=true — skips contract when parent client not in mirror', async () => {
    const mirror = new InMemoryClientMirrorRepository();
    mirror.enforceParent = true;
    // Client '111' NOT seeded → should skip
    const result = await mirror.upsertContract(makeContract('900', '111'));
    expect(result.created).toBe(false);
    expect(mirror.contracts.has('900')).toBe(false);
  });

  it('enforceParent=true — creates contract when parent client IS in mirror', async () => {
    const mirror = new InMemoryClientMirrorRepository();
    mirror.enforceParent = true;
    mirror.clients.set('111', makeClient('111'));
    const result = await mirror.upsertContract(makeContract('900', '111'));
    expect(result.created).toBe(true);
    expect(mirror.contracts.has('900')).toBe(true);
  });

  // recapture-active-client-match — Decisión 5: motivoBaja persists through the mirror (S14a/S14b)
  it('create — persists motivoBaja when GR provides it (S14a)', async () => {
    const mirror = new InMemoryClientMirrorRepository();
    const withMotivo = { ...makeContract('900', '111'), motivoBaja: 'CAMBIO DE TITULARIDAD' };
    await mirror.upsertContract(withMotivo);
    expect(mirror.contracts.get('900')?.motivoBaja).toBe('CAMBIO DE TITULARIDAD');
  });

  it('create — motivoBaja is null passthrough when GR omits it (S14b)', async () => {
    const mirror = new InMemoryClientMirrorRepository();
    await mirror.upsertContract(makeContract('900', '111'));
    expect(mirror.contracts.get('900')?.motivoBaja).toBeNull();
  });

  it('update — motivoBaja updates GR-wins on re-sync', async () => {
    const mirror = new InMemoryClientMirrorRepository();
    await mirror.upsertContract(makeContract('900', '111'));
    expect(mirror.contracts.get('900')?.motivoBaja).toBeNull();

    const updated = { ...makeContract('900', '111'), motivoBaja: 'CAMBIO DE TITULARIDAD' };
    await mirror.upsertContract(updated);
    expect(mirror.contracts.get('900')?.motivoBaja).toBe('CAMBIO DE TITULARIDAD');
  });

  // Fix-wave Finding 3a — the CLEAR direction (ghost-signal prevention). Pins this
  // against a create-only regression: if `upsertContract`'s update branch ever stops
  // reflecting the incoming `motivoBaja` (e.g. a future "merge instead of replace"
  // refactor), a client re-synced without motivoBaja would keep showing a STALE
  // churn_reason signal forever.
  it('update — motivoBaja clears back to null when GR omits it on re-sync (S14c — ghost-signal prevention)', async () => {
    const mirror = new InMemoryClientMirrorRepository();
    const withMotivo = { ...makeContract('900', '111'), motivoBaja: 'CAMBIO DE TITULARIDAD' };
    await mirror.upsertContract(withMotivo);
    expect(mirror.contracts.get('900')?.motivoBaja).toBe('CAMBIO DE TITULARIDAD');

    // Re-sync: GR no longer reports a motivoBaja for this contract (absent/null).
    await mirror.upsertContract(makeContract('900', '111'));
    expect(mirror.contracts.get('900')?.motivoBaja).toBeNull();
  });
});
