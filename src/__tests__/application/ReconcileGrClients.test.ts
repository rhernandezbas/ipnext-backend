/**
 * Use-case tests for ReconcileGrClients (read-only set-diff over the GR full
 * universe vs. the local mirror). Exercised with in-memory ports only —
 * never mocks Prisma. Covers the REQ-REC-* contract.
 */
import { ReconcileGrClients } from '../../application/use-cases/ReconcileGrClients';
import { InMemoryGestionRealPort } from '../../infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorReadRepository } from '../../infrastructure/adapters/in-memory/InMemoryClientMirrorReadRepository';
import type { GrClient } from '../../domain/entities/gestionReal';

function grClient(id: string, statusCode: string | null = '1'): GrClient {
  return {
    grClienteId: id,
    name: `Client ${id}`,
    documento: null,
    email: null,
    phone: null,
    status: null,
    statusCode,
    address: null,
    city: null,
    province: null,
    ultimaModificacion: null,
    raw: {},
  };
}

function buildGr(ids: string[], statusCode: string | null = '1'): InMemoryGestionRealPort {
  const gr = new InMemoryGestionRealPort();
  gr.clients = ids.map(id => grClient(id, statusCode));
  return gr;
}

describe('ReconcileGrClients', () => {
  it('localOnly = local − gr (orphans)', async () => {
    const gr = buildGr(['A', 'B', 'C']);
    const mirror = new InMemoryClientMirrorReadRepository(['A', 'B', 'C', 'X', 'Y']);
    const uc = new ReconcileGrClients(gr, mirror);

    const report = await uc.execute();

    expect(report.localOnly).toEqual(['X', 'Y']);
    expect(report.localOnlyCount).toBe(2);
    expect(report.grOnly).toEqual([]);
    expect(report.grOnlyCount).toBe(0);
  });

  it('grOnly = gr − local (missing inserts)', async () => {
    const gr = buildGr(['A', 'B', 'C', 'Z']);
    const mirror = new InMemoryClientMirrorReadRepository(['A', 'B', 'C']);
    const uc = new ReconcileGrClients(gr, mirror);

    const report = await uc.execute();

    expect(report.grOnly).toEqual(['Z']);
    expect(report.grOnlyCount).toBe(1);
    expect(report.localOnly).toEqual([]);
    expect(report.localOnlyCount).toBe(0);
  });

  it('identical sets → both diffs empty, totals equal', async () => {
    const gr = buildGr(['A', 'B', 'C']);
    const mirror = new InMemoryClientMirrorReadRepository(['A', 'B', 'C']);
    const uc = new ReconcileGrClients(gr, mirror);

    const report = await uc.execute();

    expect(report.localOnly).toEqual([]);
    expect(report.grOnly).toEqual([]);
    expect(report.localOnlyCount).toBe(0);
    expect(report.grOnlyCount).toBe(0);
    expect(report.localTotal).toBe(3);
    expect(report.grTotal).toBe(3);
  });

  it('does NOT filter by estado — full universe across statusCodes 1,2,3,4,6 (REQ-REC-DIFF-1)', async () => {
    const gr = new InMemoryGestionRealPort();
    gr.clients = [
      grClient('A', '1'),
      grClient('B', '2'),
      grClient('C', '3'),
      grClient('D', '4'),
      grClient('E', '6'),
    ];
    const mirror = new InMemoryClientMirrorReadRepository(['A', 'B']);
    const uc = new ReconcileGrClients(gr, mirror);

    const report = await uc.execute();

    // Every recorded fetch carries NO estado filter.
    expect(gr.calls.length).toBeGreaterThan(0);
    for (const call of gr.calls) {
      expect(call.estado).toBeUndefined();
    }
    // grTotal counts ALL estados, not just 1,2.
    expect(report.grTotal).toBe(5);
    expect(report.grOnly).toEqual(['C', 'D', 'E']);
    expect(report.grOnlyCount).toBe(3);
  });

  it('aggregates all pages with a small pageSize and terminates on offset >= total (REQ-REC-PAGINATION-1)', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const gr = buildGr(ids);
    const mirror = new InMemoryClientMirrorReadRepository(ids.slice(0, 100));
    const uc = new ReconcileGrClients(gr, mirror, { pageSize: 50 });

    const report = await uc.execute();

    expect(report.grTotal).toBe(250);
    expect(report.localTotal).toBe(100);
    expect(report.grOnlyCount).toBe(150);
    expect(report.localOnlyCount).toBe(0);
    // 250 / 50 = 5 pages; loop breaks once offset (300) >= total (250).
    expect(gr.calls.length).toBe(5);
    for (const call of gr.calls) {
      expect(call.cantidad).toBe(50);
    }
  });

  it('returns a ReconcileReportDTO shape — string[] diffs, numeric counts, no leaks (REQ-REC-PORT-1)', async () => {
    const gr = buildGr(['A', 'B', 'C', 'Z']);
    const mirror = new InMemoryClientMirrorReadRepository(['A', 'B', 'C', 'X']);
    const uc = new ReconcileGrClients(gr, mirror);

    const report = await uc.execute();

    expect(Object.keys(report).sort()).toEqual(
      ['grOnly', 'grOnlyCount', 'grTotal', 'localOnly', 'localOnlyCount', 'localTotal'].sort(),
    );
    expect(Array.isArray(report.localOnly)).toBe(true);
    expect(Array.isArray(report.grOnly)).toBe(true);
    expect(report.localOnly.every(id => typeof id === 'string')).toBe(true);
    expect(report.grOnly.every(id => typeof id === 'string')).toBe(true);
    expect(typeof report.localTotal).toBe('number');
    expect(typeof report.grTotal).toBe('number');
    expect(typeof report.localOnlyCount).toBe('number');
    expect(typeof report.grOnlyCount).toBe('number');
    expect(report.localOnlyCount).toBe(report.localOnly.length);
    expect(report.grOnlyCount).toBe(report.grOnly.length);
  });
});
